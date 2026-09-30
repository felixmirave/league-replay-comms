import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { timingKey, emptyLibrary, FutureLibraryError, sameFileVersion, validateLibrary, type Alignment, type RecordingTiming, type ClockSelection, type FileIdentity, type FileVersion, type LibraryData, type PendingImport } from './model';
import { atomicWrite } from './storage';
import type { MediaProbe } from '../shared/media';

/** One writer; public reads are snapshots, and failed writes never become saved state. */
export class ReviewLibrary {
  private data: LibraryData = emptyLibrary();
  private queue: Promise<void> = Promise.resolve();
  private issuedRevision = 0;
  private constructor(private readonly path: string) {}
  readonly warnings: string[] = [];

  static async open(directory: string): Promise<ReviewLibrary> {
    await mkdir(directory, { recursive: true });
    const library = new ReviewLibrary(join(directory, 'library.json'));
    let primaryError: unknown;
    try { library.data = validateLibrary(JSON.parse(await readFile(library.path, 'utf8'))); return library; }
    catch (error) { if (error instanceof FutureLibraryError) throw error; primaryError = error; }
    try {
      const backup = validateLibrary(JSON.parse(await readFile(`${library.path}.backup`, 'utf8')));
      if ((primaryError as NodeJS.ErrnoException)?.code !== 'ENOENT') await copyFile(library.path, `${library.path}.damaged-${randomUUID()}`);
      await atomicWrite(library.path, JSON.stringify(backup));
      library.data = backup;
      library.warnings.push('Recovered the library from its previous valid snapshot.');
      return library;
    } catch (error) {
      if (error instanceof FutureLibraryError) throw error;
      if ((primaryError as NodeJS.ErrnoException)?.code === 'ENOENT' && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return library;
      throw new Error('The saved library could not be read or recovered. Existing files have not been overwritten.', { cause: primaryError });
    }
  }

  snapshot(): LibraryData { return structuredClone(this.data); }
  async flush(): Promise<void> { await this.queue; }
  nextAlignmentRevision(): number {
    const records = [...Object.values(this.data.timings).map(item => item.alignment), ...Object.values(this.data.conflicts).flat(),
      ...Object.values(this.data.pendingImports).flatMap(item => [...Object.values(item.edits), ...Object.values(item.conflicts).flat()])];
    const preferences = [...Object.values(this.data.media), ...Object.values(this.data.pendingImports)];
    this.issuedRevision = Math.max(this.issuedRevision, ...records.map(item => item.revision), ...preferences.flatMap(item => [item.preferredTrack?.revision ?? 0, item.clockSelection?.revision ?? 0])) + 1;
    return this.issuedRevision;
  }
  async remember(identity: FileIdentity): Promise<void> { await this.transaction(data => this.putFile(data, identity)); }
  cachedIdentity(path: string, version: FileVersion): FileIdentity | undefined {
    for (const file of Object.values(this.data.media)) {
      const location = file.locations.find(item => item.path === resolve(path) && sameFileVersion(item.version, version));
      if (location) return { ...structuredClone(location), sha256: file.hash };
    }
    return undefined;
  }
  async beginImport(path: string, version: FileVersion): Promise<PendingImport> {
    let pending!: PendingImport;
    await this.transaction(data => {
      pending = Object.values(data.pendingImports).find(item => item.path === resolve(path) && sameFileVersion(item.version, version))
        ?? { id: randomUUID(), path: resolve(path), version, edits: {}, conflicts: {}, createdAt: new Date().toISOString() };
      data.pendingImports[pending.id] = pending;
    });
    return structuredClone(pending);
  }
  async savePending(id: string, values: { trackKey: string; alignment: Alignment }): Promise<void> {
    await this.transaction(data => {
      const pending = data.pendingImports[id];
      if (!pending) throw new Error('The provisional import is no longer available');
      if ((pending.edits[values.trackKey]?.revision ?? -1) > values.alignment.revision) return;
      pending.edits[values.trackKey] = values.alignment; delete pending.conflicts[values.trackKey];
      if ((pending.preferredTrack?.revision ?? -1) <= values.alignment.revision) pending.preferredTrack = { trackKey: values.trackKey, revision: values.alignment.revision };
    });
  }
  async completeImport(id: string, identity: FileIdentity, probe?: MediaProbe): Promise<void> {
    await this.transaction(data => {
      const pending = data.pendingImports[id];
      if (!pending) throw new Error('The provisional import is no longer available');
      if (!sameFileVersion(pending.version, identity.version) || pending.path !== identity.path) throw new Error('Recording changed since import; its provisional alignment was not restored');
      this.putFile(data, identity);
      const file = data.media[identity.sha256]!;
      if (pending.clockSelection && pending.clockSelection.revision > (file.clockSelection?.revision ?? -1)) file.clockSelection = pending.clockSelection;
      if (probe) file.probe = { version: 1, data: probe };
      for (const [trackKey, alignment] of Object.entries(pending.edits).sort((a, b) => a[1].revision - b[1].revision)) this.putTiming(data, identity.sha256, trackKey, alignment);
      for (const [trackKey, conflicts] of Object.entries(pending.conflicts)) {
        const key = timingKey(identity.sha256, trackKey), saved = data.timings[key];
        if (saved && saved.alignment.revision > Math.max(...conflicts.map(value => value.revision))) continue;
        data.conflicts[key] = [...(data.conflicts[key] ?? []), ...conflicts, ...(saved ? [saved.alignment] : [])]; delete data.timings[key];
      }
      if (pending.preferredTrack) this.putPreference(data, identity.sha256, pending.preferredTrack.trackKey, pending.preferredTrack.revision);
      delete data.pendingImports[id];
    });
  }
  async saveAlignment(mediaHash: string, trackKey: string, alignment: Alignment): Promise<void> {
    await this.transaction(data => { this.putTiming(data, mediaHash, trackKey, alignment); });
  }
  timing(mediaHash: string, trackKey: string): RecordingTiming | undefined { return structuredClone(this.data.timings[timingKey(mediaHash, trackKey)]); }
  conflicts(mediaHash: string, trackKey: string): Alignment[] { return structuredClone(this.data.conflicts[timingKey(mediaHash, trackKey)] ?? []); }
  async saveProbe(hash: string, probe: MediaProbe): Promise<void> {
    await this.transaction(data => {
      if (!data.media[hash]) throw new Error('Identify the recording before caching its media information');
      data.media[hash]!.probe = { version: 1, data: probe };
    });
  }
  async saveClockSelection(media: { hash?: string; importId?: string }, selection: ClockSelection): Promise<void> {
    await this.transaction(data => {
      const record = media.hash ? data.media[media.hash] : media.importId ? data.pendingImports[media.importId] : undefined;
      if (!record) throw new Error('Open and identify a recording before saving its clock region');
      if ((record.clockSelection?.revision ?? -1) < selection.revision) record.clockSelection = selection;
    });
  }
  async preferTrack(media: { hash?: string; importId?: string }, trackKey: string, revision = this.nextAlignmentRevision()): Promise<void> {
    await this.transaction(data => {
      if (media.hash) this.putPreference(data, media.hash, trackKey, revision);
      else if (media.importId && data.pendingImports[media.importId]) {
        const pending = data.pendingImports[media.importId]!;
        if ((pending.preferredTrack?.revision ?? -1) <= revision) pending.preferredTrack = { trackKey, revision };
      } else throw new Error('Open and identify the recording before saving its selected track');
    });
  }
  async updateSettings(settings: Partial<LibraryData['settings']>): Promise<void> { await this.transaction(data => { Object.assign(data.settings, settings); }); }
  private putFile(data: LibraryData, identity: FileIdentity): void {
    const existing = data.media[identity.sha256], { sha256: _, ...location } = identity;
    data.media[identity.sha256] = { ...existing, hash: identity.sha256, size: identity.version.size, name: basename(identity.path),
      locations: [location, ...(existing?.locations.filter(item => item.path !== identity.path) ?? [])], lastOpenedAt: new Date().toISOString() };
  }
  private putTiming(data: LibraryData, mediaHash: string, trackKey: string, alignment: Alignment): void {
    const key = timingKey(mediaHash, trackKey), previous = data.timings[key];
    if (!data.media[mediaHash]) throw new Error('Identify the recording before saving its timing');
    if (previous && previous.alignment.revision > alignment.revision) return;
    const now = new Date().toISOString();
    data.timings[key] = { mediaHash, trackKey, alignment, createdAt: previous?.createdAt ?? now, updatedAt: now };
    delete data.conflicts[key];
    this.putPreference(data, mediaHash, trackKey, alignment.revision);
  }
  private putPreference(data: LibraryData, hash: string, trackKey: string, revision: number): void {
    const file = data.media[hash];
    if (!file) throw new Error('Identify the recording before remembering the selected track');
    if ((file.preferredTrack?.revision ?? -1) <= revision) file.preferredTrack = { trackKey, revision };
  }
  private async transaction(change: (data: LibraryData) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data); change(next); next.revision++;
      const validated = validateLibrary(next);
      await atomicWrite(`${this.path}.backup`, JSON.stringify(this.data));
      await atomicWrite(this.path, JSON.stringify(validated)); this.data = validated;
    });
    this.queue = operation.catch(() => undefined); await operation;
  }
}
