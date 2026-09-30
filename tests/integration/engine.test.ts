import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { MediaEngine } from '../../src/sync/engine';

function wav(seconds: number): Buffer {
  const rate = 48_000;
  const samples = rate * seconds;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 5000), 44 + i * 2);
  return data;
}

describe.skipIf(!process.env.COMMS_TEST_MPV)('real mpv (null output; no audible timing claim)', () => {
  it('loads Unicode paths, performs precise paused seeks, changes rate, and stops its process', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'comms integration '));
    const file = join(folder, 'comms žaidimas.wav');
    const engine = new MediaEngine(process.env.COMMS_TEST_MPV!, resolve('resources/scripts/heartbeat.lua'), 'null');
    try {
      await writeFile(file, wav(10));
      const media = await engine.load(file);
      expect(engine.outputState().driver).toBe('null');
      expect(media.tracks.length).toBe(1);
      expect(media.durationSeconds).toBeCloseTo(10, 2);
      const first = await engine.seek(2.125);
      expect(first.paused).toBe(true);
      expect(first.positionSeconds).toBeCloseTo(2.125, 2);
      await engine.rate(2);
      await engine.pause(false);
      await delay(250);
      const moving = await engine.observe();
      expect(moving.rate).toBe(2);
      expect(moving.positionSeconds).toBeGreaterThan(2.125);
      const backward = await engine.seek(0.375);
      expect(backward.positionSeconds).toBeCloseTo(0.375, 2);
      await delay(100);
      const paused = await engine.observe();
      expect(paused.positionSeconds).toBeCloseTo(0.375, 2);
      await expect(engine.track(999)).rejects.toThrow('Unknown audio track');
      // A pending readiness check must not unpause after a newer pause intent.
      const unpause = engine.pause(false);
      await engine.pause(true); await unpause;
      expect((await engine.observe()).paused).toBe(true);
      await engine.seek(9.6); await engine.rate(1); await engine.pause(false);
      await vi.waitFor(async () => expect((await engine.observe()).paused).toBe(true), { timeout: 2000 });
      expect(engine.outputState().error).toBeUndefined();
      expect((await engine.seek(0.375)).positionSeconds).toBeCloseTo(0.375, 2);
      engine.interrupt('Synthetic power interruption');
      await expect(engine.observe()).rejects.toThrow();
      const reopened = await engine.load(file);
      expect(reopened.tracks.length).toBe(1);
      const afterInterruption = await engine.seek(0.375);
      expect(afterInterruption.paused).toBe(true);
      expect(afterInterruption.positionSeconds).toBeCloseTo(0.375, 2);
    } finally {
      await engine.close();
      await rm(folder, { recursive: true, force: true });
    }
  }, 35_000);

  it('stops on a real unexpected audio-reconfig burst and reopens paused without a restart loop', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'comms output integration '));
    const file = join(folder, 'comms.wav'), script = join(folder, 'reload.lua');
    const interrupted = vi.fn();
    const engine = new MediaEngine(process.env.COMMS_TEST_MPV!, script, 'null', interrupted);
    try {
      await writeFile(file, wav(10));
      await writeFile(script, await readFile(resolve('resources/scripts/heartbeat.lua'), 'utf8') + `
local scheduled = false
mp.observe_property('pause', 'bool', function(_, paused)
    if paused == false and not scheduled then
        scheduled = true
        mp.add_timeout(0.2, function() mp.commandv('ao-reload') end)
    end
end)
`);
      await engine.load(file);
      await engine.track(1); await engine.seek(1.5); await engine.rate(2);
      expect(interrupted).not.toHaveBeenCalled();
      await engine.pause(false);
      await vi.waitFor(() => expect(interrupted).toHaveBeenCalledOnce(), { timeout: 3000 });
      await expect(engine.observe()).rejects.toThrow();
      expect(interrupted.mock.calls[0]![0]).toMatchObject({ driver: 'null', error: expect.stringContaining('reconfigured') });
      await engine.load(file); await engine.track(1);
      expect((await engine.observe()).paused).toBe(true);
      await delay(100);
      expect(interrupted).toHaveBeenCalledOnce();
    } finally { await engine.close(); await rm(folder, { recursive: true, force: true }); }
  }, 35_000);
});
