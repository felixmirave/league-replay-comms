import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewLibrary } from '../src/library/library';
import { PreferenceEdits } from '../src/main/preference-edits';
import { ReviewSession } from '../src/main/review-session';
import { initialSnapshot, type PlaybackCommand } from '../src/shared/protocol';

let folder: string, library: ReviewLibrary, session: ReviewSession;
let commands: PlaybackCommand[];
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'comms-volume-save-'));
  library = await ReviewLibrary.open(folder);
  commands = [];
  session = new ReviewSession(library, { identify: async () => { throw new Error('No recording needed'); } }, {
    snapshot: () => structuredClone(initialSnapshot),
    send: async command => { commands.push(command); return structuredClone(initialSnapshot); },
  }, () => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  session.close(); await session.settled(); vi.useRealTimers();
  await rm(folder, { recursive: true, force: true });
});

describe('volume persistence', () => {
  it('applies each input immediately and saves only the latest value after idle', async () => {
    const writes = vi.spyOn(library, 'updateSettings');
    for (let volume = 99; volume >= 80; volume--) await session.setVolume(volume);
    expect(commands).toHaveLength(20);
    expect(commands.at(-1)).toEqual({ type: 'volume', volume: 80 });
    expect(session.snapshot()).toMatchObject({ volume: 80, unsavedPreferences: 1 });
    expect(session.snapshot().saveError).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(writes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await session.settled();
    expect(writes).toHaveBeenCalledExactlyOnceWith({ volume: 80 });
    expect((await ReviewLibrary.open(folder)).snapshot().settings.volume).toBe(80);
    expect(session.snapshot().unsavedPreferences).toBe(0);
  });

  it.each([false, true])('accepts newer playback input while an older save is blocked (failure: %s)', async fail => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const persist = library.updateSettings.bind(library);
    const writes = vi.spyOn(library, 'updateSettings').mockImplementationOnce(async value => {
      await gate;
      if (fail) throw new Error('Older write failed');
      await persist(value);
    });
    try {
      await session.setVolume(70);
      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toHaveBeenCalledOnce();
      await session.setVolume(40);
      expect(commands.at(-1)).toEqual({ type: 'volume', volume: 40 });
      expect(session.snapshot().volume).toBe(40);
      expect(session.snapshot().saveError).toBeUndefined();
      const exit = session.prepareExit();
      let finished = false; void exit.then(() => { finished = true; });
      await Promise.resolve(); expect(finished).toBe(false);
      release(); await exit;
      expect(writes).toHaveBeenCalledTimes(2);
      expect((await ReviewLibrary.open(folder)).snapshot().settings.volume).toBe(40);
      expect(session.snapshot().saveError).toBeUndefined();
      expect(session.snapshot().unsavedPreferences).toBe(0);
    } finally { release(); }
  });

  it('flushes the final input on close before the debounce expires', async () => {
    const writes = vi.spyOn(library, 'updateSettings');
    await session.setVolume(25); await session.setVolume(0);
    expect(writes).not.toHaveBeenCalled();
    await session.prepareExit();
    expect(writes).toHaveBeenCalledExactlyOnceWith({ volume: 0 });
    expect((await ReviewLibrary.open(folder)).snapshot().settings.volume).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveBeenCalledOnce();
  });

  it('reports actual deferred save failures and persists retained volume on retry', async () => {
    const write = vi.spyOn(library, 'updateSettings').mockRejectedValueOnce(new Error('Disk unavailable'));
    await session.setVolume(38);
    expect(session.snapshot().saveError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(session.snapshot().saveError).toContain('Volume: Disk unavailable');
    expect(session.snapshot()).toMatchObject({ volume: 38, unsavedPreferences: 1 });
    expect(library.snapshot().settings.volume).toBe(100);
    await session.retrySave();
    expect(write).toHaveBeenCalledTimes(2);
    expect(session.snapshot().saveError).toBeUndefined();
    expect((await ReviewLibrary.open(folder)).snapshot().settings.volume).toBe(38);
  });

  it('keeps an unrelated failure visible when an earlier preference is still pending', async () => {
    const preferences = new PreferenceEdits(library);
    preferences.stageVolume(42);
    vi.spyOn(library, 'updateSettings').mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(preferences.setting('mediaFolders', [folder])).rejects.toThrow('Disk unavailable');
    expect(preferences.count).toBe(2);
    expect(preferences.message()).toBe('1 unsaved preference. Media folders: Disk unavailable');
    await preferences.retry();
    expect(preferences.message()).toBeUndefined();
    expect((await ReviewLibrary.open(folder)).snapshot().settings).toMatchObject({ volume: 42, mediaFolders: [folder] });
  });
});
