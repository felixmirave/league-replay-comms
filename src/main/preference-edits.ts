import { basename, resolve } from 'node:path';
import type { ReviewLibrary } from '../library/library';
import { sameFileVersion, type ClockSelection, type FileIdentity, type LibraryData, type TrackPreference } from '../library/model';
import { sameMedia, type MediaReference } from './review-reference';

type Settings = LibraryData['settings'];
type Edit = { revision: number; error?: string } & (
  | { kind: 'setting'; key: keyof Settings; value: Settings[keyof Settings] }
  | { kind: 'clock'; media: MediaReference; selection: ClockSelection }
  | { kind: 'track'; media: MediaReference; trackKey: string }
);

/** Retains preference intent independently of the active recording and disk state. */
export class PreferenceEdits {
  private readonly edits = new Set<Edit>();
  constructor(private readonly library: ReviewLibrary) {}
  get count(): number { return this.edits.size; }
  message(): string | undefined {
    const edit = this.edits.values().next().value as Edit | undefined;
    if (!edit) return;
    const label = edit.kind === 'setting' ? { volume: 'Volume', mediaFolders: 'Media folders', selectedInstallation: 'League installation' }[edit.key]
      : `${basename(edit.media.path)} · ${edit.kind === 'clock' ? 'clock region' : 'selected audio track'}`;
    return `${this.count} unsaved preference${this.count === 1 ? '' : 's'}. ${label}: ${edit.error ?? 'Saving…'}`;
  }
  settings(): Settings {
    const settings = this.library.snapshot().settings;
    for (const edit of this.edits) if (edit.kind === 'setting') Object.assign(settings, { [edit.key]: structuredClone(edit.value) });
    return settings;
  }
  setting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    return this.save({ kind: 'setting', key, value: structuredClone(value), revision: this.library.nextAlignmentRevision() });
  }
  clockSelection(media: MediaReference, saved?: ClockSelection): ClockSelection | undefined {
    let latest = saved;
    for (const edit of this.edits) if (edit.kind === 'clock' && sameMedia(edit.media, media) && edit.revision > (latest?.revision ?? -1)) latest = edit.selection;
    return latest && structuredClone(latest);
  }
  saveClock(media: MediaReference, selection: ClockSelection): Promise<void> {
    return this.save({ kind: 'clock', media, selection: structuredClone(selection), revision: selection.revision });
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
    const matches = [...this.edits].filter(previous =>
      (previous.kind === 'setting' && edit.kind === 'setting' && previous.key === edit.key)
      || (previous.kind === 'track' && edit.kind === 'track' && sameMedia(previous.media, edit.media))
      || (previous.kind === 'clock' && edit.kind === 'clock' && sameMedia(previous.media, edit.media)));
    if (matches.some(previous => previous.revision > edit.revision)) return;
    for (const previous of matches) this.edits.delete(previous);
    this.edits.add(edit);
    await this.commit(edit);
  }
  private async commit(edit: Edit): Promise<void> {
    if (!this.edits.has(edit)) return;
    try {
      if (edit.kind === 'setting') await this.library.updateSettings({ [edit.key]: edit.value });
      else if (edit.kind === 'clock') await this.library.saveClockSelection(edit.media, edit.selection);
      else await this.library.preferTrack(edit.media, edit.trackKey, edit.revision);
      this.edits.delete(edit);
    } catch (error) { edit.error = error instanceof Error ? error.message : String(error); throw error; }
  }
}
