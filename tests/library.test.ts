import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyLibrary as emptyLegacy, associationKey, pendingKey } from '../src/library/legacy';
import { validateLibrary } from '../src/library/model';
import { ReviewLibrary } from '../src/library/library';
import { identifyFile } from '../src/library/identity';
import { type Alignment, type FileIdentity } from '../src/library/model';

let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'comms-library-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
const alignment = (offset: number, revision = 1): Alignment => ({ baseOffsetSeconds: offset, correctionSeconds: 0.01, source: 'manual', revision, updatedAt: new Date().toISOString() });
async function file(name: string, bytes: string) { const path = join(folder, name); await writeFile(path, bytes); return identifyFile(path); }
function oldLibrary(media: FileIdentity) {
  const data = emptyLegacy(), replay = { ...media, sha256: 'a'.repeat(64) };
  const record = (identity: FileIdentity) => { const { sha256, ...location } = identity; return { hash: sha256, name: identity.path, size: identity.version.size, locations: [location] }; };
  data.media[media.sha256] = record(media);
  data.replays[replay.sha256] = { ...record(replay), preferenceRevision: 14, preferredRecording: { mediaHash: media.sha256, trackKey: 'ff:1' } };
  const key = associationKey(replay.sha256, media.sha256, 'ff:1');
  data.associations[key] = { replayHash: replay.sha256, mediaHash: media.sha256, trackKey: 'ff:1', alignment: alignment(25, 14), createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  return { data, key, replayHash: replay.sha256 };
}

describe('review library', () => {
  it('remembers an unaligned provisional track and protects it from older alignment retries', async () => {
    const directory = join(folder, 'data'), library = await ReviewLibrary.open(directory);
    const media = await file('comms.mkv', 'recording');
    const pending = await library.beginImport(media.path, media.version);
    const oldRevision = library.nextAlignmentRevision();
    await library.savePending(pending.id, { trackKey: 'ff:1', alignment: alignment(12, oldRevision) });
    await library.preferTrack( { importId: pending.id }, 'ff:2');
    await library.completeImport(pending.id, media);
    await library.saveAlignment( media.sha256, 'ff:1', alignment(12, oldRevision));
    const restarted = await ReviewLibrary.open(directory);
    expect(restarted.snapshot().media[media.sha256]?.preferredTrack).toMatchObject({ trackKey: 'ff:2' });
    expect(restarted.timing(media.sha256, 'ff:2')).toBeUndefined();
    expect(restarted.timing( media.sha256, 'ff:1')?.alignment.baseOffsetSeconds).toBe(12);
  });

  it('persists timing by recording contents and track across restart and rename', async () => {
    const library = await ReviewLibrary.open(join(folder, 'data'));
    const media = await file('original.mkv', 'video contents');
    await library.remember( media);
    await library.saveAlignment( media.sha256, 'ff:1', alignment(45));
    await library.saveAlignment( media.sha256, 'ff:2', alignment(46));
    const moved = join(folder, 'renamed recording.mkv');
    await rename(media.path, moved);
    const found = await identifyFile(moved);
    expect(found.sha256).toBe(media.sha256);
    await library.remember( found);
    const restarted = await ReviewLibrary.open(join(folder, 'data'));
    expect(restarted.timing( found.sha256, 'ff:1')?.alignment.baseOffsetSeconds).toBe(45);
    expect(restarted.timing(media.sha256, 'ff:2')?.trackKey).toBe('ff:2');
    expect(restarted.snapshot().media[media.sha256]?.locations[0]?.path).toBe(moved);
  });

  it('merges the latest provisional manual edit when hashing finishes', async () => {
    const library = await ReviewLibrary.open(join(folder, 'data'));
    const media = await file('original.wav', 'comms');
    const pending = await library.beginImport(media.path, media.version);
    await library.savePending(pending.id, { trackKey: 'ff:0', alignment: alignment(10, 1) });
    await library.savePending(pending.id, { trackKey: 'ff:0', alignment: alignment(11, 2) });
    await library.savePending(pending.id, { trackKey: 'ff:0', alignment: alignment(9, 1) });
    await library.completeImport(pending.id, media);
    expect(library.timing(media.sha256, 'ff:0')?.alignment.baseOffsetSeconds).toBe(11);
    expect(library.snapshot().pendingImports).toEqual({});
  });

  it('recovers provisional edits after restart, but never after file replacement', async () => {
    const directory = join(folder, 'data');
    const library = await ReviewLibrary.open(directory);
    const media = await file('original.wav', 'original');
    const pending = await library.beginImport(media.path, media.version);
    const restart = await ReviewLibrary.open(directory);
    expect((await restart.beginImport(media.path, media.version)).id).toBe(pending.id);
    // Use a different size: a rapid same-size overwrite can retain both
    // timestamps on filesystems with coarse timestamp resolution.
    await writeFile(media.path, 'modified recording');
    const replacement = await identifyFile(media.path);
    expect(replacement.sha256).not.toBe(media.sha256);
    expect(restart.cachedIdentity( media.path, replacement.version)).toBeUndefined();
    await expect(restart.completeImport(pending.id, replacement)).rejects.toThrow('changed');
    expect((await restart.beginImport(media.path, replacement.version)).id).not.toBe(pending.id);
  });

  it('keeps provisional edits for every track and cannot overwrite a newer saved edit after restart', async () => {
    const directory = join(folder, 'data');
    const library = await ReviewLibrary.open(directory);
    const media = await file('comms.mkv', 'tracks');
    await library.remember( media);
    const pending = await library.beginImport(media.path, media.version);
    await library.savePending(pending.id, { trackKey: 'ff:1', alignment: alignment(10, library.nextAlignmentRevision()) });
    await library.savePending(pending.id, { trackKey: 'ff:2', alignment: alignment(20, library.nextAlignmentRevision()) });
    const restarted = await ReviewLibrary.open(directory);
    await restarted.saveAlignment( media.sha256, 'ff:1', alignment(30, restarted.nextAlignmentRevision()));
    await restarted.completeImport(pending.id, media);
    expect(restarted.timing( media.sha256, 'ff:1')?.alignment.baseOffsetSeconds).toBe(30);
    expect(restarted.timing( media.sha256, 'ff:2')?.alignment.baseOffsetSeconds).toBe(20);
    expect(restarted.snapshot().media[media.sha256]?.preferredTrack?.trackKey).toBe('ff:1');
  });

  it('migrates the version-one provisional alignment without losing it', async () => {
    const directory = join(folder, 'data'); await ReviewLibrary.open(directory);
    const media = await file('comms.wav', 'comms');
    const { data, replayHash } = oldLibrary(media); data.associations = {};
    const pending = { id: 'pending', path: media.path, version: media.version, createdAt: '2026-01-01', replayHash, trackKey: 'ff:0', alignment: alignment(13, 14) };
    await writeFile(join(directory, 'library.json'), JSON.stringify({ ...data, schemaVersion: 1, replays: { [replayHash]: { ...data.replays[replayHash], preferredRecording: undefined } }, pendingImports: { pending } }));
    const migrated = await ReviewLibrary.open(directory);
    expect(migrated.nextAlignmentRevision()).toBe(15);
    await migrated.completeImport('pending', media);
    expect(migrated.timing(media.sha256, 'ff:0')?.alignment.baseOffsetSeconds).toBe(13);
    expect(JSON.parse(await readFile(join(directory, 'library.json'), 'utf8')).schemaVersion).toBe(6);
    expect(migrated.snapshot().legacy?.pendingImports.pending?.edits[pendingKey(replayHash, 'ff:0')]?.alignment.baseOffsetSeconds).toBe(13);
  });

  it('serializes independent updates and does not expose mutable saved state', async () => {
    const library = await ReviewLibrary.open(join(folder, 'data'));
    await Promise.all([library.updateSettings({ volume: 42 }), library.updateSettings({ mediaFolders: [folder] })]);
    const snapshot = library.snapshot();
    snapshot.settings.volume = 1;
    expect(library.snapshot().settings).toMatchObject({ volume: 42, mediaFolders: [folder] });
    const restart = await ReviewLibrary.open(join(folder, 'data'));
    expect(restart.snapshot().settings).toMatchObject({ volume: 42, mediaFolders: [folder] });
  });
  it.each([2, 3, 4, 5])('migrates version %s and retains the normalized legacy library', async version => {
    const directory = join(folder, 'data'); await ReviewLibrary.open(directory);
    const media = await file('saved.mkv', 'saved recording'), { data, key, replayHash } = oldLibrary(media);
    const raw = { ...data, schemaVersion: version, replays: version === 5 ? data.replays : { [replayHash]: { ...data.replays[replayHash], preferredRecording: undefined, preferredAssociation: key } } };
    await writeFile(join(directory, 'library.json'), JSON.stringify(raw));
    const migrated = await ReviewLibrary.open(directory);
    expect(migrated.snapshot().legacy).toEqual(data);
    expect(migrated.timing(media.sha256, 'ff:1')?.alignment).toEqual(data.associations[key]!.alignment);
    expect(migrated.snapshot().media[media.sha256]?.preferredTrack).toEqual({ trackKey: 'ff:1', revision: 14 });
    expect(migrated.nextAlignmentRevision()).toBe(15);
  });
  it('preserves conflicting replay-specific offsets without activating either, until explicitly corrected', async () => {
    const directory = join(folder, 'data'); await ReviewLibrary.open(directory);
    const media = await file('saved.mkv', 'saved recording'), { data, key, replayHash } = oldLibrary(media);
    const second = 'b'.repeat(64);
    data.replays[second] = { ...data.replays[replayHash]!, hash: second };
    data.associations[associationKey(second, media.sha256, 'ff:1')] = { ...data.associations[key]!, replayHash: second, alignment: alignment(80, 20) };
    await writeFile(join(directory, 'library.json'), JSON.stringify(data));
    const migrated = await ReviewLibrary.open(directory);
    expect(migrated.timing(media.sha256, 'ff:1')).toBeUndefined();
    expect(migrated.conflicts(media.sha256, 'ff:1').map(item => item.baseOffsetSeconds)).toEqual([25, 80]);
    const correction = alignment(32, migrated.nextAlignmentRevision());
    await migrated.saveAlignment(media.sha256, 'ff:1', correction);
    const restart = await ReviewLibrary.open(directory);
    expect(restart.conflicts(media.sha256, 'ff:1')).toEqual([]);
    expect(restart.timing(media.sha256, 'ff:1')?.alignment).toEqual(correction);
    expect(restart.snapshot().legacy).toEqual(data);
  });
  it('combines identical offsets using the newest revision without losing correction or evidence', async () => {
    const media = await file('same.mkv', 'same'), { data, key, replayHash } = oldLibrary(media);
    const second = 'b'.repeat(64); data.replays[second] = { ...data.replays[replayHash]!, hash: second };
    data.associations[associationKey(second, media.sha256, 'ff:1')] = { ...data.associations[key]!, replayHash: second, alignment: { ...data.associations[key]!.alignment, revision: 90 } };
    const migrated = validateLibrary(data);
    expect(Object.values(migrated.timings)).toHaveLength(1);
    expect(Object.values(migrated.timings)[0]?.alignment).toMatchObject({ baseOffsetSeconds: 25, correctionSeconds: 0.01, revision: 90 });
    expect(migrated.conflicts).toEqual({});
  });

  it('drops obsolete crop preferences without losing timing or unfinished edits', async () => {
    const directory = join(folder, 'data'), library = await ReviewLibrary.open(directory);
    const media = await file('clock.mkv', 'clock footage');
    await library.remember(media);
    await library.saveAlignment(media.sha256, 'ff:1', alignment(12));
    const pending = await library.beginImport(media.path, media.version);
    await library.savePending(pending.id, { trackKey: 'ff:2', alignment: alignment(25, 2) });
    const data = library.snapshot();
    Object.assign(data.media[media.sha256]!, { clockSelection: { videoStreamIndex: 0, crop: { x: 0, y: 0, width: 1, height: 1 }, revision: 99 } });
    Object.assign(data.pendingImports[pending.id]!, { clockSelection: 'obsolete data is ignored' });
    await writeFile(join(directory, 'library.json'), JSON.stringify(data));
    const restarted = await ReviewLibrary.open(directory);
    expect(restarted.warnings).toEqual([]);
    expect(restarted.snapshot().media[media.sha256]).not.toHaveProperty('clockSelection');
    expect(restarted.snapshot().pendingImports[pending.id]).not.toHaveProperty('clockSelection');
    await restarted.completeImport(pending.id, media);
    const latest = await ReviewLibrary.open(directory);
    expect(latest.timing(media.sha256, 'ff:1')?.alignment.baseOffsetSeconds).toBe(12);
    expect(latest.timing(media.sha256, 'ff:2')?.alignment.baseOffsetSeconds).toBe(25);
    expect(await readFile(join(directory, 'library.json'), 'utf8')).not.toContain('clockSelection');
  });

  it('migrates old libraries with retired crop preferences and retains automatic timing evidence', async () => {
    const media = await file('old clock.mkv', 'old clock footage'), { data, key } = oldLibrary(media);
    const crop = { x: 0, y: 0, width: 1, height: 1 };
    const saved: Alignment = { ...alignment(25, 15), source: 'video-clock', clock: {
      crop, videoStreamIndex: 0, originSeconds: 0,
      evidence: { algorithmVersion: 2, method: 'transition-midpoint', midpointSeconds: 125,
        before: { mediaSeconds: 124.99, clockSeconds: 99, confidence: 90 }, after: { mediaSeconds: 125.01, clockSeconds: 100, confidence: 90 } },
    } };
    data.associations[key]!.alignment = saved;
    Object.assign(data.media[media.sha256]!, { clockSelection: { videoStreamIndex: 0, crop, revision: 16 } });
    const migrated = validateLibrary(data);
    expect(Object.values(migrated.timings)[0]?.alignment).toEqual(saved);
    expect(migrated.media[media.sha256]).not.toHaveProperty('clockSelection');
  });

  it('restores a valid backup after interrupted/corrupt primary writes', async () => {
    const directory = join(folder, 'data');
    const library = await ReviewLibrary.open(directory);
    await library.updateSettings({ volume: 42 });
    await library.updateSettings({ volume: 50 });
    await writeFile(join(directory, 'library.json'), '{partial');
    const recovered = await ReviewLibrary.open(directory);
    expect(recovered.snapshot().settings.volume).toBe(42);
    expect(recovered.warnings).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, 'library.json'), 'utf8')).settings.volume).toBe(42);
  });

  it('refuses a future schema even when an older backup exists', async () => {
    const directory = join(folder, 'data');
    const library = await ReviewLibrary.open(directory);
    await library.updateSettings({ volume: 42 });
    const future = '{"schemaVersion":99,"important":"data"}';
    await writeFile(join(directory, 'library.json'), future);
    await expect(ReviewLibrary.open(directory)).rejects.toThrow('unsupported application version');
    expect(await readFile(join(directory, 'library.json'), 'utf8')).toBe(future);
  });

  it('retains saved state and permits retry after a filesystem write failure', async () => {
    const directory = join(folder, 'data');
    const moved = join(folder, 'temporarily-moved');
    const library = await ReviewLibrary.open(directory);
    await library.updateSettings({ volume: 42 });
    await rename(directory, moved);
    await writeFile(directory, 'not a directory');
    await expect(library.updateSettings({ volume: 50 })).rejects.toThrow();
    expect(library.snapshot().settings.volume).toBe(42);
    await rm(directory);
    await rename(moved, directory);
    await library.updateSettings({ volume: 50 });
    expect((await ReviewLibrary.open(directory)).snapshot().settings.volume).toBe(50);
  });
});
