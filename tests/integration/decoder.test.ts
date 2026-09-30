import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaDecoder } from '../../src/analysis/decoder';
import { DecoderQueue } from '../../src/analysis/decoder-client';
import { fileVersion } from '../../src/library/identity';
import type { FrameRequest, WaveformRequest } from '../../src/shared/analysis';

const run = promisify(execFile);
const enabled = !!(process.env.COMMS_TEST_FFMPEG && process.env.COMMS_TEST_FFPROBE);
describe.skipIf(!enabled)('real timestamped previews', () => {
  let folder: string, path: string, workerPath: string;
  let frame: FrameRequest, wave: WaveformRequest;
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'comms-decoder-'));
    path = join(folder, 'vfr delayed stereo.mkv');
    workerPath = join(folder, 'decoder.cjs');
    await build({ entryPoints: [resolve('src/analysis/decoder-entry.ts')], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs' });
    await run(process.env.COMMS_TEST_FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,0.5\\,0.6)\\,0.8\\,0)|-if(between(t\\,0.5\\,0.6)\\,0.8\\,0):s=48000:d=2', '-map', '0:v', '-map', '1:a', '-vf', "select='if(lt(t,1.5),not(mod(n,2)),1)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_f32le', '-output_ts_offset', '5', path]);
    const version = await fileVersion(path);
    frame = { kind: 'frame', path, version, streamIndex: 0, originSeconds: 5, positionSeconds: 1.11 };
    wave = { kind: 'waveform', path, version, streamIndex: 1, originSeconds: 5, sampleRate: 48000, startSeconds: 0, endSeconds: 3, bucketSeconds: 0.02 };
  });
  afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

  it('returns actual VFR frame PTS after a nonzero seek, with a usable image and normalized crop', async () => {
    const decoded = await new MediaDecoder(process.env.COMMS_TEST_FFMPEG!).decode(frame);
    expect(decoded.kind).toBe('frame');
    if (decoded.kind !== 'frame') throw new Error('Expected frame');
    const output = await run(process.env.COMMS_TEST_FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', path]);
    const timestamps = JSON.parse(output.stdout).frames.map((item: { best_effort_timestamp_time: string }) => Number(item.best_effort_timestamp_time));
    const actualNext = timestamps.find((pts: number) => pts >= 6.11);
    expect(decoded.ptsSeconds).toBeCloseTo(actualNext, 5);
    expect(decoded.positionSeconds).toBeCloseTo(actualNext - 5, 5);
    expect(decoded.positionSeconds).not.toBe(frame.positionSeconds);
    expect(decoded.dataUrl).toMatch(/^data:image\/png;base64,/);
    const crop = await new MediaDecoder(process.env.COMMS_TEST_FFMPEG!).decode({ ...frame, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.25 } });
    expect(crop.kind === 'frame' && crop.width / crop.height).toBeCloseTo(160 / 44, 1);
  });

  it('keeps stereo peaks and their real timestamps without downmix cancellation or a reset to zero', async () => {
    const decoded = await new MediaDecoder(process.env.COMMS_TEST_FFMPEG!).decode(wave);
    if (decoded.kind !== 'waveform') throw new Error('Expected waveform');
    expect(decoded.peaks[0]?.[0]).toBeCloseTo(0.5, 2);
    const audible = decoded.peaks.filter(bucket => bucket[3] > 0.5 || bucket[2] < -0.5);
    expect(audible.length).toBeGreaterThan(2);
    expect(audible[0]?.[0]).toBeGreaterThanOrEqual(0.98);
    expect(audible.at(-1)?.[1]).toBeLessThanOrEqual(1.13);
    expect(decoded.peaks.at(-1)?.[1]).toBeCloseTo(2.5, 2);
    expect(Math.max(...decoded.peaks.map(peak => peak[3]))).toBeCloseTo(0.8, 1);
  });

  it('returns the immediate successor by actual VFR PTS, including nonzero timeline origins', async () => {
    const output = await run(process.env.COMMS_TEST_FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', path]);
    const timestamps: number[] = JSON.parse(output.stdout).frames.map((item: { best_effort_timestamp_time: string }) => Number(item.best_effort_timestamp_time));
    const decoder = new MediaDecoder(process.env.COMMS_TEST_FFMPEG!);
    for (const position of [0, 1.4, 1.6, 2.5]) {
      const before = await decoder.decode({ ...frame, positionSeconds: position });
      if (before.kind !== 'frame') throw new Error('Expected frame');
      const after = await decoder.decode({ ...frame, positionSeconds: before.positionSeconds, after: true });
      if (after.kind !== 'frame') throw new Error('Expected next frame');
      const index = timestamps.findIndex(t => Math.abs(t - before.ptsSeconds) < 1e-8);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(after.ptsSeconds).toBeCloseTo(timestamps[index + 1]!, 8);
    }
  });

  it('rejects replaced sources and cancelled jobs', async () => {
    const copied = join(folder, 'replaced.mkv'); await copyFile(path, copied);
    const version = await fileVersion(copied); await writeFile(copied, 'replaced');
    await expect(new MediaDecoder(process.env.COMMS_TEST_FFMPEG!).decode({ ...frame, path: copied, version })).rejects.toThrow('changed');
    const abort = new AbortController();
    const decoding = new MediaDecoder(process.env.COMMS_TEST_FFMPEG!).decode(frame, abort.signal);
    abort.abort();
    await expect(decoding).rejects.toThrow();
  });

  it('prioritizes interactive frames over queued background chunks and cancels obsolete queued work', async () => {
    const queue = new DecoderQueue(workerPath, process.env.COMMS_TEST_FFMPEG!);
    const order: string[] = [];
    try {
      const first = queue.waveform(wave).then(() => { order.push('first'); });
      const later = queue.waveform(wave).then(() => { order.push('later'); });
      const interactive = queue.frame(frame).then(() => { order.push('frame'); });
      const abort = new AbortController();
      const obsolete = queue.waveform(wave, abort.signal); abort.abort();
      await expect(obsolete).rejects.toThrow('cancelled');
      await Promise.all([first, later, interactive]);
      expect(order).toEqual(['first', 'frame', 'later']);
    } finally { await queue.close(); }
  });
});
