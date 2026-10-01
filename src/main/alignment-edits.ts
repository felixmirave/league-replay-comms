import { basename, resolve } from 'node:path';
import { sameFileVersion, type Alignment, type FileIdentity } from '../library/model';
import type { ReviewLibrary } from '../library/library';
import { sameMedia, type MediaReference } from './review-reference';

interface Edit { media: MediaReference; trackKey: string; alignment: Alignment; error?: string }

/** Unsaved intent belongs to a review identity, not to the currently displayed view. */
export class AlignmentEdits {
  private edits = new Set<Edit>();
  constructor(private readonly library: ReviewLibrary) {}
  get count(): number { return this.edits.size; }
  message(): string | undefined {
    const failed = [...this.edits].filter(edit => edit.error !== undefined);
    const first = failed[0];
    if (!first) return;
    return `${failed.length} unsaved alignment${failed.length === 1 ? '' : 's'}. ${basename(first.media.path)}: ${first.error}`;
  }
  lookup(media: MediaReference, trackKey: string): Alignment | undefined {
    const entries = [...this.edits].filter(edit => sameMedia(edit.media, media) && edit.trackKey === trackKey);
    const latest = entries.sort((a, b) => b.alignment.revision - a.alignment.revision)[0];
    return latest && structuredClone(latest.alignment);
  }
  async save(media: MediaReference, trackKey: string, alignment: Alignment): Promise<void> {
    const previous = this.lookup(media, trackKey);
    if (previous && previous.revision > alignment.revision) return;
    for (const edit of this.edits) if (sameMedia(edit.media, media) && edit.trackKey === trackKey) this.edits.delete(edit);
    const edit: Edit = { media, trackKey, alignment: structuredClone(alignment) };
    this.edits.add(edit);
    await this.commit(edit);
  }
  identifyMedia(importId: string, identity: FileIdentity): void {
    for (const { media } of this.edits) if (media.importId === importId && resolve(media.path) === identity.path && sameFileVersion(media.version, identity.version)) { media.hash = identity.sha256; media.importId = undefined; }
  }
  async retry(): Promise<void> {
    const errors: unknown[] = [];
    // Revision ordering also preserves preferred-track intent when several saves recover.
    for (const edit of [...this.edits].sort((a, b) => a.alignment.revision - b.alignment.revision)) {
      try { await this.commit(edit); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, this.message());
  }
  private async commit(edit: Edit): Promise<void> {
    try {
      if (edit.media.hash) await this.library.saveAlignment(edit.media.hash, edit.trackKey, edit.alignment);
      else if (edit.media.importId) await this.library.savePending(edit.media.importId, { trackKey: edit.trackKey, alignment: edit.alignment });
      else throw new Error('Reopen the recording to identify it before saving.');
      this.edits.delete(edit);
    } catch (error) { edit.error = error instanceof Error ? error.message : String(error); throw error; }
  }
}
