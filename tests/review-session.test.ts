import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewSession, type IdentityJobs, type PlaybackPort } from '../src/main/review-session';
import { ReviewLibrary } from '../src/library/library';
import { identifyFile } from '../src/library/identity';
import { initialSnapshot, type PlaybackCommand, type ProbeSnapshot } from '../src/shared/protocol';
import type { FileIdentity } from '../src/library/model';
import type { MediaProbe } from '../src/shared/media';
import type { VideoClockJobs, VideoClockRequest, VideoClockResult } from '../src/analysis/video-clock';
import { GuidedWorkflow } from '../src/main/workflow';
import { fitClock } from '../src/analysis/clock-fit';

let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'comms-session-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

class Player implements PlaybackPort {
  state: ProbeSnapshot = { ...structuredClone(initialSnapshot), replay: { sessionId: 'runtime-a', timeSeconds: 10, paused: true, seeking: false, speed: 1, lengthSeconds: 2000, sentAtSeconds: 0, receivedAtSeconds: 0 } };
  commands: PlaybackCommand[] = [];
  snapshot(): ProbeSnapshot { return structuredClone(this.state); }
  async send(command: PlaybackCommand): Promise<ProbeSnapshot> {
    this.commands.push(command);
    if (command.type === 'load') this.state.media = { name: basename(command.path), durationSeconds: 2000, tracks: [{ id: 1, title: 'Comms', selected: true, ffIndex: 1 }, { id: 2, title: 'Microphone', selected: false, ffIndex: 2 }], selectedTrackId: 1 };
    if (command.type === 'track' && this.state.media) this.state.media.selectedTrackId = command.trackId;
    if (command.type === 'apply-alignment') this.state.offsetSeconds = command.offsetSeconds;
    if (command.type === 'update-probe' && this.state.media) {
      this.state.media.probe = command.probe;
      for (const track of this.state.media.tracks) track.range = { startSeconds: 0, endSeconds: 2000, evidence: 'packet-scan' };
    }
    return this.snapshot();
  }
}
async function fixtures() {
  const media = join(folder, 'recording.mkv');
  await writeFile(media, 'original recording');
  return { media, library: await ReviewLibrary.open(join(folder, 'data')) };
}
const direct: IdentityJobs = { identify: identifyFile };
function timing(library: ReviewLibrary, session: ReviewSession) {
  const hash = session.snapshot().recording!.hash!;
  const track = library.snapshot().media[hash]?.preferredTrack?.trackKey ?? 'ff:1';
  return library.timing(hash, track);
}

describe('review workflow', () => {
  it.each([{ track: 1 }, { track: 2 }, { track: 2, offset: 12 }])('resumes an unfinished import after normal exit: %j', async choice => {
    const { media, library } = await fixtures();
    const identity = await identifyFile(media);
    let complete!: (value: FileIdentity) => void;
    const pending = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const first = new ReviewSession(library, { identify: path => path === media ? pending : identifyFile(path) }, new Player(), () => {});

    await first.openMedia(media);
    const recentId = `pending:${Object.keys(library.snapshot().pendingImports)[0]}`;
    await first.selectTrack(choice.track);
    if ('offset' in choice) await first.setManualOffset(choice.offset!);
    expect(first.snapshot().recording?.hash).toBeUndefined();
    await first.prepareExit(); expect(first.snapshot().saveError).toBeUndefined();
    first.close(); complete(identity); await first.settled();
    expect(Object.values(library.snapshot().pendingImports)).toHaveLength(1);
    const restarted = await ReviewLibrary.open(join(folder, 'data')), player = new Player();
    const next = new ReviewSession(restarted, direct, player, () => {});
    await next.selectRecording(recentId); await next.settled();
    expect(next.snapshot().recording?.hash).toBe(identity.sha256);
    expect(player.state.media?.selectedTrackId).toBe(choice.track);
    expect(player.state.offsetSeconds).toBe('offset' in choice ? choice.offset : undefined);
    expect(restarted.snapshot().pendingImports).toEqual({});
    expect(restarted.snapshot().media[identity.sha256]?.preferredTrack).toMatchObject({ trackKey: `ff:${choice.track}` });
  });

  it.each(['changed', 'missing'])('refuses a %s unfinished recording without reopening an older saved recording', async mode => {
    const { media, library } = await fixtures();
    const later = join(folder, 'later recording.mkv'); await writeFile(later, 'second original recording');
    const original = await identifyFile(later);
    let complete!: (identity: FileIdentity) => void;
    const pending = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const first = new ReviewSession(library, { identify: path => path === later ? pending : identifyFile(path) }, new Player(), () => {});
    await first.openMedia(media); await first.settled();
    await first.setManualOffset(4);
    await first.openMedia(later); await first.setManualOffset(18);
    const recentId = `pending:${Object.keys(library.snapshot().pendingImports)[0]}`;
    await first.prepareExit(); first.close(); complete(original); await first.settled();
    if (mode === 'changed') await writeFile(later, 'different recording now occupies this path');
    else await rm(later);
    const restarted = await ReviewLibrary.open(join(folder, 'data')), player = new Player();
    const next = new ReviewSession(restarted, direct, player, () => {});
    await next.selectRecording(recentId); await next.settled();
    expect(next.snapshot().error).toContain(mode === 'changed' ? 'changed since import' : 'original path is missing');
    expect(player.state.media).toBeUndefined();
    expect(player.state.offsetSeconds).toBeUndefined();
    expect(Object.values(restarted.snapshot().pendingImports)).toHaveLength(1);
  });

  it('restores a newer verified choice ahead of an older unfinished import', async () => {
    const { media, library } = await fixtures();
    const older = join(folder, 'earlier.mkv'); await writeFile(older, 'earlier recording');
    const identity = await identifyFile(older);
    let complete!: (identity: FileIdentity) => void;
    const pending = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const first = new ReviewSession(library, { identify: path => path === older ? pending : identifyFile(path) }, new Player(), () => {});
    await first.openMedia(older); await first.setManualOffset(7);
    await first.openMedia(media); await first.setManualOffset(19);
    complete(identity); await first.settled();
    await first.prepareExit(); first.close();
    const player = new Player(), restarted = await ReviewLibrary.open(join(folder, 'data'));
    const next = new ReviewSession(restarted, direct, player, () => {});
    await next.selectRecording(first.snapshot().recordings[0]!.id); await next.settled();
    expect(player.state.media?.name).toBe('recording.mkv');
    expect(player.state.offsetSeconds).toBe(19);
  });



  it('rejects media changed during decoder loading before applying provisional alignment', async () => {
    const { media, library } = await fixtures();
    const identity = await identifyFile(media);
    const provisional = await library.beginImport(media, identity.version);
    await library.savePending(provisional.id, { trackKey: 'ff:1', alignment: { source: 'manual', baseOffsetSeconds: 31, correctionSeconds: 0, revision: library.nextAlignmentRevision(), updatedAt: new Date().toISOString() } });
    const player = new Player(), original = player.send.bind(player);
    player.send = async command => {
      const state = await original(command);
      if (command.type === 'load') await writeFile(media, 'new contents during decoder load');
      return state;
    };
    const next = new ReviewSession(library, direct, player, () => {});
    await next.selectRecording(`pending:${provisional.id}`); await next.settled();
    expect(next.snapshot().error).toContain('changed while opening');
    expect(player.commands.some(command => command.type === 'apply-alignment' && command.offsetSeconds !== undefined)).toBe(false);
    expect(Object.values(library.snapshot().pendingImports)).toHaveLength(1);
  });

  it('remembers an unaligned recording and selected track across restart and rename', async () => {
    const { media, library } = await fixtures();
    const session = new ReviewSession(library, direct, new Player(), () => {});
    await session.openMedia(media); await session.settled();
    await session.selectTrack(2);
    const mediaHash = session.snapshot().recording!.hash!;
    expect(library.snapshot().media[mediaHash]?.preferredTrack).toMatchObject({ trackKey: 'ff:2' });
    expect(library.timing(mediaHash, 'ff:2')).toBeUndefined();
    session.close();
    await rename(media, join(folder, 'renamed unaligned.mkv'));
    const player = new Player(), restarted = await ReviewLibrary.open(join(folder, 'data'));
    const next = new ReviewSession(restarted, direct, player, () => {});
    await next.selectRecording(`media:${mediaHash}`); await next.settled();
    expect(player.state.media?.name).toBe('renamed unaligned.mkv');
    expect(player.state.media?.selectedTrackId).toBe(2);
    expect(next.snapshot().alignment).toBeUndefined();
    await next.resume();
    expect(player.state.offsetSeconds).toBeUndefined();
  });

  it('restores the saved track discovered after hashing a manually opened renamed recording', async () => {
    const { media, library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled();
    await session.selectTrack(2); await session.setManualOffset(12);
    const renamed = join(folder, 'different name.mkv'); await rename(media, renamed);
    await session.openMedia(renamed); await session.settled();
    expect(player.state.media?.selectedTrackId).toBe(2);
    expect(player.state.offsetSeconds).toBe(12);
  });

  it('retains the newest volume and added folders during a disk failure and retries them on exit', async () => {
    const { media, library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled();
    const directory = join(folder, 'data'), moved = join(folder, 'unavailable-data');
    await rename(directory, moved); await writeFile(directory, 'not a directory');
    await session.setVolume(25);
    await session.setVolume(38);
    await session.settled();
    expect(session.snapshot().saveError).toContain('Volume');
    await expect(session.addFolder(join(folder, 'first'))).rejects.toThrow();
    await expect(session.addFolder(join(folder, 'second'))).rejects.toThrow();
    expect(session.snapshot()).toMatchObject({ volume: 38, folders: [join(folder, 'first'), join(folder, 'second')], unsavedPreferences: 2 });
    expect(player.commands.filter(command => command.type === 'volume').at(-1)).toEqual({ type: 'volume', volume: 38 });
    expect(library.snapshot().settings.volume).toBe(100);
    await session.prepareExit();
    expect(session.snapshot().saveError).toContain('2 unsaved preferences');
    await rm(directory); await rename(moved, directory);
    await session.retryExitSave();
    expect(session.snapshot().saveError).toBeUndefined();
    const restarted = await ReviewLibrary.open(directory);
    expect(restarted.snapshot().settings).toMatchObject({ volume: 38, mediaFolders: [join(folder, 'first'), join(folder, 'second')] });
    session.close();
  });

  it('saves volume intent even when the playback process fails', async () => {
    const { library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    player.send = async () => { throw new Error('Player disconnected'); };
    await expect(session.setVolume(29)).rejects.toThrow('Player disconnected');
    expect(session.snapshot().volume).toBe(29);
    await session.settled();
    expect((await ReviewLibrary.open(join(folder, 'data'))).snapshot().settings.volume).toBe(29);
    expect(session.snapshot().saveError).toBeUndefined();
  });

  it('keeps a failed track choice across recording switches without overwriting a later choice on retry', async () => {
    const { media, library } = await fixtures();
    const other = join(folder, 'other.wav'); await writeFile(other, 'another recording');
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled();
    const fail = vi.spyOn(library, 'preferTrack').mockRejectedValue(new Error('Cannot save track'));
    await expect(session.selectTrack(2)).rejects.toThrow('Cannot save track');
    await session.openMedia(other); await session.settled();
    await session.openMedia(media); await session.settled();
    // The unsaved choice was restored for this recording. A newer choice must win.
    expect(player.state.media?.selectedTrackId).toBe(2);
    fail.mockRestore(); await session.selectTrack(1); await session.retrySave();
    expect(session.snapshot().unsavedPreferences).toBe(0);
    expect(library.snapshot().media[session.snapshot().recording!.hash!]?.preferredTrack?.trackKey).toBe('ff:1');
    expect(player.state.media?.selectedTrackId).toBe(1);
  });

  it('follows automatically and retains the recording through disconnects and live timing edits', async () => {
    const { media, library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled(); await session.selectTrack(1);
    await session.setManualOffset(0);
    expect(player.commands.at(-1)).toEqual({ type: 'apply-alignment', offsetSeconds: 0, replaySessionId: 'runtime-a' });
    player.commands.length = 0;
    await session.enterTiming();
    await session.setManualOffset(.1); await session.setManualOffset(-.1);
    expect(player.commands).toEqual([
      { type: 'apply-alignment', offsetSeconds: .1, replaySessionId: 'runtime-a' },
      { type: 'apply-alignment', offsetSeconds: -.1, replaySessionId: 'runtime-a' },
    ]);
    const commandsBeforeDone = player.commands.length;
    await session.resume();
    expect(player.commands).toHaveLength(commandsBeforeDone);
    player.state.connectionError = 'Disconnected'; session.onPlayback(player.snapshot());
    expect(session.snapshot().boundToRuntime).toBe(true);
    player.state.connectionError = undefined;
    await session.setManualOffset(-.2);
    expect(player.commands.at(-1)).toEqual({ type: 'apply-alignment', offsetSeconds: -.2, replaySessionId: 'runtime-a' });
    await session.stop(); await session.setManualOffset(5);
    expect(player.commands.at(-1)).toEqual({ type: 'apply-alignment', offsetSeconds: 5, replaySessionId: undefined });
    await session.resume();
    expect(player.commands.at(-1)).toEqual({ type: 'apply-alignment', offsetSeconds: 5, replaySessionId: 'runtime-a' });
  });

  it.each([NaN, Infinity, -Infinity, 86400.1, -86400.1])('rejects invalid offsets without changing accepted timing: %s', async value => {
    const { media, library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled(); await session.setManualOffset(3);
    await expect(session.setManualOffset(value)).rejects.toThrow('within 24 hours');
    expect(player.state.offsetSeconds).toBe(3);
    expect(timing(library, session)?.alignment.baseOffsetSeconds).toBe(3);
  });

  it('restores a preferred track and corrected offset after restarting and renaming the recording', async () => {
    const { media, library } = await fixtures();
    const first = new ReviewSession(library, direct, new Player(), () => {});

    await first.openMedia(media); await first.settled();
    await first.selectTrack(2);
    await first.setManualOffset(45);
    await first.setManualOffset(45.01);
    const recentId = first.snapshot().recordings[0]!.id;
    await rename(media, join(folder, 'renamed comms.mkv'));
    const restarted = await ReviewLibrary.open(join(folder, 'data'));
    const player = new Player();
    const next = new ReviewSession(restarted, direct, player, () => {});
    await next.selectRecording(recentId); await next.settled();
    expect(player.state.media?.name).toBe('renamed comms.mkv');
    expect(player.state.media?.selectedTrackId).toBe(2);
    expect(player.state.offsetSeconds).toBeCloseTo(45.01);
    expect(next.snapshot().alignment).toMatchObject({ baseOffsetSeconds: 45.01, correctionSeconds: 0 });
    await next.resume();
    expect(player.commands.at(-1)).toMatchObject({ type: 'apply-alignment', replaySessionId: 'runtime-a' });
  });

  it('keeps manual changes made while the media hash is pending', async () => {
    const { media, library } = await fixtures();
    let complete!: (identity: FileIdentity) => void;
    const hash = identifyFile(media);
    const pendingHash = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const jobs: IdentityJobs = { identify: path => path === media ? pendingHash : identifyFile(path) };
    const player = new Player();
    const session = new ReviewSession(library, jobs, player, () => {});

    await session.openMedia(media);
    await session.setManualOffset(12);
    await session.setManualOffset(12.1);
    expect(session.snapshot().recording?.hash).toBeUndefined();
    expect(Object.values(Object.values(library.snapshot().pendingImports)[0]!.edits)[0]?.baseOffsetSeconds).toBeCloseTo(12.1);
    complete(await hash); await session.settled();
    expect(player.state.offsetSeconds).toBeCloseTo(12.1);
    expect(timing(library, session)?.alignment.baseOffsetSeconds).toBeCloseTo(12.1);
  });

  it('requires choosing a recording for a new viewer before automatic playback can resume', async () => {
    const { media, library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled(); await session.selectTrack(1);
    await session.setManualOffset(45);
    player.state.replay!.sessionId = 'runtime-b'; session.onPlayback(player.snapshot());
    expect(session.snapshot()).toMatchObject({ boundToRuntime: false, needsRecordingChoice: true });
    await session.resume(); await session.setManualOffset(46);
    expect(player.commands.at(-1)).toMatchObject({ type: 'apply-alignment', replaySessionId: undefined });
    await session.openMedia(media); await session.settled();
    expect(session.snapshot().needsRecordingChoice).toBe(false);
    expect([...player.commands].reverse().find(command => command.type === 'apply-alignment')).toMatchObject({ replaySessionId: 'runtime-b', offsetSeconds: 46 });
  });

  it('automatically attaches an offline preparation when a verified viewer becomes available', async () => {
    const { media, library } = await fixtures();
    const player = new Player(), replay = player.state.replay; player.state.replay = undefined;
    const session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled(); await session.selectTrack(1); await session.setManualOffset(12);
    player.state.media!.tracks[0]!.range = { startSeconds: 0, endSeconds: 2000, evidence: 'packet-scan' };
    player.state.replay = replay; session.onPlayback(player.snapshot()); await session.settled();
    expect(player.commands.at(-1)).toEqual({ type: 'apply-alignment', offsetSeconds: 12, replaySessionId: 'runtime-a' });
  });

  it('mute retains the chosen volume and survives recording replacement', async () => {
    const { media, library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled();
    await session.setVolume(63); await session.setMuted(true); await session.setVolume(47);
    expect(player.commands.at(-1)).toEqual({ type: 'volume', volume: 0 });
    expect(session.snapshot()).toMatchObject({ volume: 47, muted: true });
    await session.openMedia(media); await session.settled();
    expect([...player.commands].reverse().find(command => command.type === 'volume')).toEqual({ type: 'volume', volume: 0 });
    expect((await ReviewLibrary.open(join(folder, 'data'))).snapshot().settings).toMatchObject({ volume: 47, muted: true });
    await session.setMuted(false);
    expect(player.commands.at(-1)).toEqual({ type: 'volume', volume: 47 });
    session.close();
  });

  it('never applies a late hash from a previously selected recording to its replacement', async () => {
    const { media, library } = await fixtures();
    const other = join(folder, 'other.wav'); await writeFile(other, 'other contents');
    let complete!: (identity: FileIdentity) => void;
    const identity = await identifyFile(media);
    const pendingHash = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const player = new Player();
    const session = new ReviewSession(library, { identify: path => path === media ? pendingHash : identifyFile(path) }, player, () => {});

    await session.openMedia(media);
    await session.setManualOffset(10);
    await session.openMedia(other);
    await session.setManualOffset(20);
    complete(identity); await session.settled();
    expect(player.state.media?.name).toBe('other.wav');
    expect(player.state.offsetSeconds).toBe(20);
    expect(session.snapshot().recording?.hash).toBe((await identifyFile(other)).sha256);
  });

  it('keeps audio-only manual alignment available while disconnected, but prevents following', async () => {
    const { media, library } = await fixtures();
    const player = new Player(); player.state.replay = undefined;
    const session = new ReviewSession(library, direct, player, () => {});

    await session.openMedia(media); await session.settled();
    await session.setManualOffset(-120);
    expect(session.snapshot().alignment?.baseOffsetSeconds).toBe(-120);
    expect(timing(library, session)?.alignment.baseOffsetSeconds).toBe(-120);
    await session.resume();
    expect(session.snapshot().boundToRuntime).toBe(false);
  });

  it('remembers independent track edits while hashing, and restores both after completion', async () => {
    const { media, library } = await fixtures();
    let complete!: (identity: FileIdentity) => void;
    const pending = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const player = new Player();
    const session = new ReviewSession(library, { identify: path => path === media ? pending : identifyFile(path) }, player, () => {});

    await session.openMedia(media);
    await session.setManualOffset(10);
    await session.selectTrack(2);
    await session.setManualOffset(20);
    await session.selectTrack(1);
    expect(player.state.offsetSeconds).toBe(10);
    complete(await identifyFile(media)); await session.settled();
    expect(timing(library, session)?.trackKey).toBe('ff:1');
    await session.selectTrack(2);
    expect(player.state.offsetSeconds).toBe(20);
    expect(timing(library, session)?.trackKey).toBe('ff:2');
    expect(Object.values(library.snapshot().timings)).toHaveLength(2);
  });



  it('retains unsaved track edits through a disk failure, switches, and retry', async () => {
    const { media, library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled();
    await session.setManualOffset(5);
    const directory = join(folder, 'data'), moved = join(folder, 'unavailable-data');
    await rename(directory, moved); await writeFile(directory, 'not a directory');
    await expect(session.setManualOffset(10)).rejects.toThrow();
    expect(player.state.offsetSeconds).toBe(10);
    await expect(session.selectTrack(2)).rejects.toThrow();
    await expect(session.setManualOffset(20)).rejects.toThrow();
    expect(session.snapshot().unsavedAlignments).toBe(2);
    expect(timing(library, session)?.alignment.baseOffsetSeconds).toBe(5);
    await rm(directory); await rename(moved, directory);
    await session.selectTrack(1);
    expect(player.state.offsetSeconds).toBe(10);
    await session.retrySave();
    expect(session.snapshot().saveError).toBeUndefined();
    expect(session.snapshot().unsavedAlignments).toBe(0);
    await session.selectTrack(2); expect(player.state.offsetSeconds).toBe(20);
    const restored = await ReviewLibrary.open(directory);
    expect(restored.timing(session.snapshot().recording!.hash!, 'ff:1')?.alignment.baseOffsetSeconds).toBe(10);
    expect(restored.timing(session.snapshot().recording!.hash!, 'ff:2')?.alignment.baseOffsetSeconds).toBe(20);
  });

  it('retries failed saves for independent recordings without moving timing between them', async () => {
    const { media, library } = await fixtures();
    const other = join(folder, 'other.wav'); await writeFile(other, 'different recording');
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled();
    const firstHash = session.snapshot().recording!.hash!;
    const fail = vi.spyOn(library, 'saveAlignment').mockRejectedValue(new Error('Disk unavailable'));
    await expect(session.setManualOffset(10)).rejects.toThrow('Disk unavailable');
    await session.openMedia(other); await session.settled();
    await expect(session.setManualOffset(20)).rejects.toThrow('Disk unavailable');
    expect(session.snapshot().unsavedAlignments).toBe(2);
    fail.mockRestore(); await session.retrySave();
    expect(session.snapshot().unsavedAlignments).toBe(0);
    expect(library.timing(firstHash, 'ff:1')?.alignment.baseOffsetSeconds).toBe(10);
    expect(player.state.offsetSeconds).toBe(20);
    expect(timing(library, session)?.alignment.baseOffsetSeconds).toBe(20);
  });

  it('promotes failed provisional track saves when hashing finishes without losing the inactive track', async () => {
    const { media, library } = await fixtures();
    let complete!: (identity: FileIdentity) => void;
    const pending = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const player = new Player(), session = new ReviewSession(library, { identify: path => path === media ? pending : identifyFile(path) }, player, () => {});
    await session.openMedia(media);
    const fail = vi.spyOn(library, 'savePending').mockRejectedValue(new Error('Disk unavailable'));
    await expect(session.setManualOffset(11)).rejects.toThrow('Disk unavailable');
    await session.selectTrack(2);
    await expect(session.setManualOffset(22)).rejects.toThrow('Disk unavailable');
    fail.mockRestore(); complete(await identifyFile(media)); await session.settled();
    expect(session.snapshot().unsavedAlignments).toBe(1);
    await session.retrySave(); await session.selectTrack(1);
    expect(player.state.offsetSeconds).toBe(11);
    expect(session.snapshot().unsavedAlignments).toBe(0);
    expect(Object.values(library.snapshot().timings)).toHaveLength(2);
  });



  it('drains accepted edits before freezing exit, and resumes queued work when closing is cancelled', async () => {
    const { media, library } = await fixtures();
    const player = new Player(), session = new ReviewSession(library, direct, player, () => {});
    await session.openMedia(media); await session.settled();
    let finishWrite!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finishWrite = resolve; });
    const actual = library.saveAlignment.bind(library);
    vi.spyOn(library, 'saveAlignment').mockImplementationOnce(async (...args) => { started(); await blocked; await actual(...args); });
    const first = session.setManualOffset(10), second = session.setManualOffset(10.01), exit = session.prepareExit();
    await waiting;
    expect(session.snapshot().saveError).toBeUndefined();
    expect(session.snapshot().unsavedAlignments).toBe(1);
    let frozen = false; void exit.then(() => { frozen = true; });
    expect(frozen).toBe(false);
    finishWrite(); await Promise.all([first, second, exit]);
    expect(timing(library, session)?.alignment.baseOffsetSeconds).toBe(10.01);
    const late = session.setManualOffset(20);
    await Promise.resolve(); expect(player.state.offsetSeconds).toBeCloseTo(10.01);
    session.resumeAfterExit(); await late;
    expect(player.state.offsetSeconds).toBe(20);
    await session.prepareExit();
    const obsolete = session.setManualOffset(99);
    session.close(); await expect(obsolete).rejects.toThrow('closed');
    expect(timing(library, session)?.alignment.baseOffsetSeconds).toBe(20);
  });

  it('ignores an obsolete relocation result after the user opens another recording', async () => {
    const { media, library } = await fixtures();
    const first = new ReviewSession(library, direct, new Player(), () => {});

    await first.openMedia(media); await first.settled();
    await first.setManualOffset(45);
    const moved = join(folder, 'moved.mkv'); await rename(media, moved);
    const other = join(folder, 'other.wav'); await writeFile(other, 'other audio');
    let complete!: (identity: FileIdentity) => void;
    let started!: () => void;
    const scanning = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const player = new Player();
    const session = new ReviewSession(library, { identify: path => { if (path === moved) { started(); return pending; } return identifyFile(path); } }, player, () => {});
    await session.selectRecording(first.snapshot().recordings.find(item => item.id.startsWith('media:'))!.id);
    await scanning;
    await session.openMedia(other); await session.setManualOffset(20);
    complete(await identifyFile(moved)); await session.settled();
    expect(player.state.media?.name).toBe('other.wav');
    expect(player.state.offsetSeconds).toBe(20);
    expect(session.snapshot().error).toBeUndefined();
  });

  it('preserves manual revisions while background audio timing finishes', async () => {
    const { media, library } = await fixtures();
    let complete!: (probe: MediaProbe) => void;
    const pending = new Promise<MediaProbe>(resolve => { complete = resolve; });
    const probe: MediaProbe = { formats: ['matroska'], streams: [{ type: 'audio', codec: 'aac', index: 1 }] };
    const player = new Player();
    const session = new ReviewSession(library, direct, player, () => {}, { inspect: async () => probe, inspectRanges: async () => pending });

    await session.openMedia(media);
    expect(session.snapshot().timingAnalysis).toBe('running');
    await session.setManualOffset(45); await session.setManualOffset(45.01);
    complete({ ...probe, streams: [{ ...probe.streams[0]!, packetRange: { startPtsSeconds: 0, endPtsSeconds: 2000 } }] });
    await session.settled();
    expect(player.state.offsetSeconds).toBeCloseTo(45.01);
    expect(session.snapshot().timingAnalysis).toBeUndefined();
    expect(library.snapshot().media[session.snapshot().recording!.hash!]!.probe?.data.streams[0]?.packetRange?.endPtsSeconds).toBe(2000);
  });

  it('never attaches a previous recording’s timing scan to a new recording', async () => {
    const { media, library } = await fixtures();
    const other = join(folder, 'other.wav'); await writeFile(other, 'different contents');
    let complete!: (probe: MediaProbe) => void;
    const pending = new Promise<MediaProbe>(resolve => { complete = resolve; });
    const probe: MediaProbe = { formats: ['matroska'], streams: [{ type: 'audio', codec: 'aac', index: 1 }] };
    const player = new Player();
    const session = new ReviewSession(library, direct, player, () => {}, { inspect: async () => probe, inspectRanges: async path => path === media ? pending : probe });

    await session.openMedia(media);
    await session.openMedia(other); await session.setManualOffset(20);
    complete({ ...probe, durationSeconds: 99999 }); await session.settled();
    expect(player.state.media?.probe?.durationSeconds).not.toBe(99999);
    expect(player.state.media?.name).toBe('other.wav');
    expect(player.state.offsetSeconds).toBe(20);
  });
});

const videoProbe: MediaProbe = { formats: ['matroska'], streams: [{ type: 'video', codec: 'h264', index: 0, startPtsSeconds: 0 }, { type: 'audio', codec: 'aac', index: 1, startPtsSeconds: 0, durationSeconds: 2000 }] };
class VideoPlayer extends Player {
  override async send(command: PlaybackCommand): Promise<ProbeSnapshot> {
    await super.send(command);
    if (command.type === 'load' && this.state.media) { this.state.media.originSeconds = 0; this.state.media.probe = command.probe; }
    return this.snapshot();
  }
}
class ClockJobs implements VideoClockJobs {
  calls: { request: VideoClockRequest; signal?: AbortSignal; complete(result: VideoClockResult): void; fail(error: Error): void }[] = [];
  private started!: () => void;
  readonly first = new Promise<void>(resolve => { this.started = resolve; });
  analyze(request: VideoClockRequest, signal?: AbortSignal): Promise<VideoClockResult> {
    return new Promise((complete, fail) => { this.calls.push({ request, signal, complete, fail }); this.started(); });
  }
}
function clockResult(offsetSeconds = 45): VideoClockResult {
  const readings = [
    { mediaSeconds: 100 + offsetSeconds - 0.01, clockSeconds: 99, confidence: 90 },
    { mediaSeconds: 100 + offsetSeconds + 0.01, clockSeconds: 100, confidence: 90 },
  ];
  return { crop: { x: 0.965, y: 0, width: 0.035, height: 0.0242 }, readings, framesRead: 12,
    fit: { status: 'accepted', offsetSeconds, uncertaintySeconds: 0.01,
      evidence: { algorithmVersion: 2, method: 'transition-midpoint', before: readings[0]!, after: readings[1]!, midpointSeconds: 100 + offsetSeconds } } };
}
describe('clock analysis application', () => {
  async function setup() {
    const { media, library } = await fixtures();
    const player = new VideoPlayer(), clocks = new ClockJobs();
    const session = new ReviewSession(library, direct, player, () => {}, { inspect: async () => videoProbe }, clocks);

    await session.openMedia(media); await session.selectTrack(1);
    await clocks.first;
    expect(clocks.calls).toHaveLength(1);
    return { session, player, clocks, library, media };
  }
  it.each(['unreadable', 'decoder error', 'time limit'])('falls directly back to manual timing after %s without restarting detection', async failure => {
    const { session, player, clocks } = await setup();
    const flow = new GuidedWorkflow(), facts = () => ({ ...player.snapshot(), library: session.snapshot() });
    expect(flow.observe(facts()).state).toBe('alignment.analyzing');
    if (failure === 'unreadable') clocks.calls[0]!.complete({ fit: fitClock([]), readings: [], framesRead: 60 });
    else clocks.calls[0]!.fail(new Error(failure));
    await session.settled();
    expect(flow.observe(facts())).toMatchObject({ state: 'alignment.manual', primary: 'Done' });
    expect(session.snapshot().alignment).toBeUndefined();
    const editor = flow.observe(facts());
    await session.enterTiming(); await session.settled();
    expect(clocks.calls).toHaveLength(1);
    expect(flow.observe(facts()).editorKey).toBe(editor.editorKey);
    await session.setManualOffset(3); flow.complete();
    expect(session.snapshot().alignment?.source).toBe('manual');
    expect(player.state.offsetSeconds).toBe(3);
    expect(session.snapshot().clock).toBeUndefined();
    expect(session.snapshot().boundToRuntime).toBe(true);
  });
  it('always uses automatic localization for new analysis, ignoring legacy user-selected clock regions', async () => {
    const { media, library } = await fixtures();
    const identity = await identifyFile(media); await library.remember(identity);
    const data = library.snapshot();
    Object.assign(data.media[identity.sha256]!, { clockSelection: { videoStreamIndex: 99, crop: { x: 0, y: 0, width: 1, height: 1 }, revision: 10 } });
    await writeFile(join(folder, 'data', 'library.json'), JSON.stringify(data));
    const restored = await ReviewLibrary.open(join(folder, 'data')), clocks = new ClockJobs();
    const session = new ReviewSession(restored, direct, new VideoPlayer(), () => {}, { inspect: async () => videoProbe }, clocks);
    await session.openMedia(media); await session.selectTrack(1); await clocks.first;
    expect(clocks.calls[0]!.request).toMatchObject({ streamIndex: 0, force: false });
    expect(clocks.calls[0]!.request).not.toHaveProperty('crop');
    clocks.calls[0]!.complete(clockResult()); await session.settled();
    await session.analyzeVideo();
    expect(clocks.calls[1]!.request).toMatchObject({ streamIndex: 0, force: true });
    expect(clocks.calls[1]!.request).not.toHaveProperty('crop');
    clocks.calls[1]!.complete(clockResult()); await session.settled();
    expect(session.snapshot().alignment?.source).toBe('video-clock');
  });
  it('protects a manual offset edit from a late automatic result', async () => {
    const { session, clocks, player, library } = await setup();
    await session.setManualOffset(12); await session.setManualOffset(12.01);
    expect(clocks.calls[0]!.signal?.aborted).toBe(true);
    clocks.calls[0]!.complete(clockResult()); await session.settled();
    expect(player.state.offsetSeconds).toBeCloseTo(12.01);
    expect(timing(library, session)?.alignment.source).toBe('manual');
  });
  it('restores a saved manual association before starting initial clock automation after hashing', async () => {
    const { media, library } = await fixtures();
    const player = new VideoPlayer(), clocks = new ClockJobs();
    let complete!: (identity: FileIdentity) => void;
    const pending = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const session = new ReviewSession(library, { identify: path => path === media ? pending : identifyFile(path) }, player, () => {}, { inspect: async () => videoProbe }, clocks);

    const identity = await identifyFile(media);
    // Simulate a saved association known by content at another, no-longer-used path.
    await library.remember( { ...identity, path: join(folder, 'old location.mkv') });
    await library.saveAlignment(identity.sha256, 'ff:1', { baseOffsetSeconds: 17, correctionSeconds: 0.01, source: 'manual', revision: library.nextAlignmentRevision(), updatedAt: new Date().toISOString() });
    await session.openMedia(media);
    expect(clocks.calls).toHaveLength(0);
    complete(identity); await session.settled();
    expect(clocks.calls).toHaveLength(0);
    expect(player.state.offsetSeconds).toBeCloseTo(17.01);
  });
  it('does not restart clock reading after cancellation while identification is still pending', async () => {
    const { media, library } = await fixtures();
    const clocks = new ClockJobs();
    let complete!: (identity: FileIdentity) => void;
    const pending = new Promise<FileIdentity>(resolve => { complete = resolve; });
    const session = new ReviewSession(library, { identify: path => path === media ? pending : identifyFile(path) }, new VideoPlayer(), () => {}, { inspect: async () => videoProbe }, clocks);
    await session.openMedia(media);
    await session.analyzeVideo(); session.cancelClock();
    clocks.calls[0]!.complete(clockResult()); complete(await identifyFile(media)); await session.settled();
    expect(clocks.calls).toHaveLength(1);
    expect(session.snapshot().alignment).toBeUndefined();
  });
  it('retains an existing alignment on a failed re-run, then commits a successful re-run with evidence and no old correction', async () => {
    const { session, clocks, player, library } = await setup();
    clocks.calls[0]!.complete(clockResult()); await session.settled();
    await session.setManualOffset(45.1);
    await session.analyzeVideo();
    clocks.calls[1]!.fail(new Error('Clock obscured')); await session.settled();
    expect(player.state.offsetSeconds).toBeCloseTo(45.1);
    expect(session.snapshot().clock?.message).toContain('obscured');
    await session.analyzeVideo();
    clocks.calls[2]!.complete(clockResult(46)); await session.settled();
    expect(player.state.offsetSeconds).toBe(46);
    const saved = timing(library, session)!.alignment;
    expect(saved.correctionSeconds).toBe(0); expect(saved.clock?.evidence.algorithmVersion).toBe(2);
    const restored = await ReviewLibrary.open(join(folder, 'data'));
    expect(timing(restored, session)?.alignment.clock).toEqual(saved.clock);
  });
  it('uses the latest analysis request and ignores a result from a previous track', async () => {
    const { session, clocks, player } = await setup();
    await session.analyzeVideo();
    clocks.calls[1]!.complete(clockResult(50)); clocks.calls[0]!.complete(clockResult(80)); await session.settled();
    expect(player.state.offsetSeconds).toBe(50);
    await session.analyzeVideo(); await session.selectTrack(2);
    clocks.calls[2]!.complete(clockResult(90)); session.cancelClock(); clocks.calls[3]?.complete(clockResult(95)); await session.settled();
    expect(player.state.offsetSeconds).toBeUndefined();
    expect(player.state.media?.selectedTrackId).toBe(2);
  });
  it('applies a single-transition result automatically without a phase profile', async () => {
    const { session, clocks, player } = await setup();
    clocks.calls[0]!.complete(clockResult()); await session.settled();
    expect(player.state.offsetSeconds).toBe(45);
    expect(session.snapshot().clock?.status).toBe('accepted');
    expect(session.snapshot().alignment?.source).toBe('video-clock');
    expect(session.snapshot().boundToRuntime).toBe(true);
  });
  it('refuses to apply clock results after source content changes', async () => {
    const { session, clocks, player, media } = await setup();
    clocks.calls[0]!.complete(clockResult()); await session.settled();
    await session.analyzeVideo(); await writeFile(media, 'changed video content');
    clocks.calls[1]!.complete(clockResult(80)); await session.settled();
    expect(player.state.offsetSeconds).toBe(45);
    expect(session.snapshot().clock?.message).toContain('changed');
  });
  it('saves a manual edit even when playback cannot apply it', async () => {
    const { session, clocks, player, library } = await setup();
    clocks.calls[0]!.complete(clockResult()); await session.settled();
    const original = player.send.bind(player);
    player.send = async command => { if (command.type === 'apply-alignment') throw new Error('Engine stopped'); return original(command); };
    await expect(session.setManualOffset(15)).rejects.toThrow('Engine stopped');
    expect(timing(library, session)?.alignment.baseOffsetSeconds).toBe(15);
  });
});
