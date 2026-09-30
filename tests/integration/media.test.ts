import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ffprobe } from '../../src/analysis/probe';
import { MediaEngine } from '../../src/sync/engine';
import { frameMediaTime } from '../../src/shared/media';

const run = promisify(execFile);
const enabled = !!(process.env.COMMS_TEST_FFMPEG && process.env.COMMS_TEST_FFPROBE && process.env.COMMS_TEST_MPV);
describe.skipIf(!enabled)('real media timeline fixtures', () => {
  for (const format of ['mp4', 'mkv']) it(`preserves a nonzero ${format} origin and delayed, shorter audio track`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'comms-media-'));
    const path = join(folder, `nonzero.${format}`);
    const engine = new MediaEngine(process.env.COMMS_TEST_MPV!, resolve('resources/scripts/heartbeat.lua'), 'null');
    try {
      await run(process.env.COMMS_TEST_FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
        '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-map', '0:v', '-map', '1:a', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-output_ts_offset', '5', path]);
      const probe = await new Ffprobe(process.env.COMMS_TEST_FFPROBE!).inspect(path);
      const opened = await engine.load(path, probe);
      expect(opened.originSeconds).toBeTypeOf('number');
      const range = opened.tracks[0]?.range;
      expect(range).toBeDefined();
      expect(range!.startSeconds + opened.originSeconds!).toBeCloseTo(5.48, 1);
      expect(range!.endSeconds + opened.originSeconds!).toBeCloseTo(7.5, 1);
      expect(opened.durationSeconds + opened.originSeconds!).toBeCloseTo(8, 1);
      const mapped = frameMediaTime(6.25, opened.originSeconds!);
      expect(mapped).toBeGreaterThan(range!.startSeconds);
      expect(mapped).toBeLessThan(range!.endSeconds);
      const sample = await engine.seek(mapped);
      expect(sample.positionSeconds).toBeCloseTo(mapped, 2);
      expect(opened.tracks).toHaveLength(2);
      await engine.track(opened.tracks[1]!.id);
      const switched = await engine.observe();
      expect(switched.paused).toBe(true);
      expect(switched.positionSeconds).toBeCloseTo(mapped, 2);
      expect(probe.streams.find(stream => stream.type === 'video')!.startPtsSeconds).toBe(5);
    } finally { await engine.close(); await rm(folder, { recursive: true, force: true }); }
  });
  it('rejects corrupt media and honors cancellation without leaving a probe process', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'comms-probe-'));
    const prober = new Ffprobe(process.env.COMMS_TEST_FFPROBE!);
    try {
      const path = join(folder, 'broken.mp4'); await writeFile(path, 'not a recording');
      await expect(prober.inspect(path)).rejects.toThrow('Could not inspect');
      const abort = new AbortController(); abort.abort();
      await expect(prober.inspect(path, abort.signal)).rejects.toThrow();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('finds audio bounds from packets when Matroska track-duration metadata cannot be trusted', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'comms-packets-'));
    const path = join(folder, 'no encoder tag.mkv');
    const encoded = join(folder, 'encoded.mkv');
    const prober = new Ffprobe(process.env.COMMS_TEST_FFPROBE!);
    const engine = new MediaEngine(process.env.COMMS_TEST_MPV!, resolve('resources/scripts/heartbeat.lua'), 'null');
    try {
      await run(process.env.COMMS_TEST_FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'aac', '-output_ts_offset', '5', encoded]);
      await run(process.env.COMMS_TEST_FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-copyts', '-i', encoded, '-c', 'copy', '-metadata:s:a', 'encoder=Recorder', path]);
      const probe = await prober.inspect(path);
      expect(probe.streams[0]?.durationSeconds).toBeUndefined();
      expect(probe.streams[0]?.taggedEndPtsSeconds).toBeUndefined();
      const detailed = await prober.inspectRanges(path, probe);
      const loaded = await engine.load(path, probe);
      const opened = engine.updateProbe(loaded, detailed);
      expect(opened.tracks[0]?.range?.evidence).toBe('packet-scan');
      expect(opened.tracks[0]!.range!.endSeconds - opened.tracks[0]!.range!.startSeconds).toBeCloseTo(2, 1);
      expect((await engine.seek(1)).positionSeconds).toBeCloseTo(1, 2);
      const abort = new AbortController();
      const scanning = prober.inspectRanges(path, probe, abort.signal);
      abort.abort();
      await expect(scanning).rejects.toThrow('cancelled');
    } finally { await engine.close(); await rm(folder, { recursive: true, force: true }); }
  });
});
