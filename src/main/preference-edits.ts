import { basename, resolve } from 'node:path';
import type { ReviewLibrary } from '../library/library';
import { sameFileVersion, type FileIdentity, type LibraryData, type TrackPreference } from '../library/model';
import { sameMedia, type MediaReference } from './review-reference';

type Settings = LibraryData['settings'];
type Edit = { revision: number; error?: string } & (
  | { kind: 'setting'; key: keyof Settings; value: Settings[keyof Settings] }
  | { kind: 'track'; media: MediaReference; trackKey: string }
);

/** Retains preference intent independently of the active recording and disk state. */
export class PreferenceEdits {
  private readonly edits = new Set<Edit>();
  constructor(private readonly library: ReviewLibrary) {}
  get count(): number { return this.edits.size; }
  message(): string | undefined {
    const failed = [...this.edits].filter(edit => edit.error !== undefined);
    const edit = failed[0];
    if (!edit) return;
    const label = edit.kind === 'setting' ? { volume: 'Volume', filters: 'Sound filters', mediaFolders: 'Media folders', selectedInstallation: 'League installation' }[edit.key]
      : `${basename(edit.media.path)} · selected audio track`;
    return `${failed.length} unsaved preference${failed.length === 1 ? '' : 's'}. ${label}: ${edit.error}`;
  }
  settings(): Settings {
    const settings = this.library.snapshot().settings;
    for (const edit of this.edits) if (edit.kind === 'setting') Object.assign(settings, { [edit.key]: structuredClone(edit.value) });
    return settings;
  }
  setting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    return this.save({ kind: 'setting', key, value: structuredClone(value), revision: this.library.nextAlignmentRevision() });
  }
  stageFilters(filters: Settings['filters']): void {
    this.retain({ kind: 'setting', key: 'filters', value: structuredClone(filters), revision: this.library.nextAlignmentRevision() });
  }
  stageVolume(volume: number): void {
    this.retain({ kind: 'setting', key: 'volume', value: volume, revision: this.library.nextAlignmentRevision() });
  }
  async flushAudioPreferences(): Promise<void> {
    const edits = [...this.edits].filter(edit => edit.kind === 'setting' && (edit.key === 'volume' || edit.key === 'filters'));
    for (const edit of edits) await this.commit(edit);
  }
  preferTrack(media: MediaReference, trackKey: string, revision = this.library.nextAlignmentRevision()): Promise<void> {
    return this.save({ kind: 'track', media, trackKey, revision });
  }
  preferredTrack(media: MediaReference): TrackPreference | undefined {
    const data = this.library.snapshot();
    let latest = media.hash ? data.media[media.hash]?.preferredTrack : media.importId ? data.pendingImports[media.importId]?.preferredTrack : undefined;
    for (const edit of this.edits) if (edit.kind === 'track' && sameMedia(edit.media, media) && edit.revision > (latest?.revision ?? -1)) latest = { trackKey: edit.trackKey, revision: edit.revision };
    return latest && structuredClone(latest);
  }
  identifyMedia(importId: string, identity: FileIdentity): void {
    for (const edit of this.edits) if (edit.kind !== 'setting' && edit.media.importId === importId && resolve(edit.media.path) === identity.path && sameFileVersion(edit.media.version, identity.version)) {
      edit.media.hash = identity.sha256; edit.media.importId = undefined;
    }
  }
  async retry(): Promise<void> {
    const errors: unknown[] = [];
    for (const edit of [...this.edits].sort((a, b) => a.revision - b.revision)) {
      try { await this.commit(edit); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, this.message());
  }
  private async save(edit: Edit): Promise<void> {
    if (this.retain(edit)) await this.commit(edit);
  }
  private retain(edit: Edit): boolean {
    const matches = [...this.edits].filter(previous =>
      (previous.kind === 'setting' && edit.kind === 'setting' && previous.key === edit.key)
      || (previous.kind === 'track' && edit.kind === 'track' && sameMedia(previous.media, edit.media)));
    if (matches.some(previous => previous.revision > edit.revision)) return false;
    for (const previous of matches) this.edits.delete(previous);
    this.edits.add(edit);
    return true;
  }
  private async commit(edit: Edit): Promise<void> {
    if (!this.edits.has(edit)) return;
    try {
      if (edit.kind === 'setting') await this.library.updateSettings({ [edit.key]: edit.value });
      else await this.library.preferTrack(edit.media, edit.trackKey, edit.revision);
      this.edits.delete(edit);
    } catch (error) { edit.error = error instanceof Error ? error.message : String(error); throw error; }
  }
}
