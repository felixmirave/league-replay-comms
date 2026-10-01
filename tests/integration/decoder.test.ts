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
import type { FrameRequest } from '../../src/shared/analysis';

const run = promisify(execFile);
const enabled = !!(process.env.COMMS_TEST_FFMPEG && process.env.COMMS_TEST_FFPROBE);
describe.skipIf(!enabled)('real clock frames', () => {
  let folder: string, path: string, workerPath: string;
  let frame: FrameRequest;
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'comms-decoder-'));
    path = join(folder, 'vfr clock.mkv');
    workerPath = join(folder, 'decoder.cjs');
    await build({ entryPoints: [resolve('src/analysis/decoder-entry.ts')], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs' });
    await run(process.env.COMMS_TEST_FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-vf', "select='if(lt(t,1.5),not(mod(n,2)),1)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-output_ts_offset', '5', path]);
    const version = await fileVersion(path);
    frame = { path, version, streamIndex: 0, originSeconds: 5, positionSeconds: 1.11, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.25 } };
  });
  afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

  it('returns actual VFR frame PTS after a nonzero seek, with a bounded grayscale clock crop', async () => {
    const decoded = await new MediaDecoder(process.env.COMMS_TEST_FFMPEG!).decode(frame);
    const output = await run(process.env.COMMS_TEST_FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', path]);
    const timestamps = JSON.parse(output.stdout).frames.map((item: { best_effort_timestamp_time: string }) => Number(item.best_effort_timestamp_time));
    const actualNext = timestamps.find((pts: number) => pts >= 6.11);
    expect(decoded.ptsSeconds).toBeCloseTo(actualNext, 5);
    expect(decoded.positionSeconds).toBeCloseTo(actualNext - 5, 5);
    expect(decoded.positionSeconds).not.toBe(frame.positionSeconds);
    expect(decoded.width).toBeLessThanOrEqual(480);
    expect(decoded.height).toBeLessThanOrEqual(120);
    expect(decoded.width / decoded.height).toBeCloseTo(160 / 44, 1);
    expect(Buffer.from(decoded.png.subarray(0, 8))).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(decoded.png[25]).toBe(0); // PNG IHDR color type: grayscale.

  });

  it('returns the immediate successor by actual VFR PTS, including nonzero timeline origins', async () => {
    const output = await run(process.env.COMMS_TEST_FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', path]);
    const timestamps: number[] = JSON.parse(output.stdout).frames.map((item: { best_effort_timestamp_time: string }) => Number(item.best_effort_timestamp_time));
    const decoder = new MediaDecoder(process.env.COMMS_TEST_FFMPEG!);
    for (const position of [0, 1.4, 1.6, 2.5]) {
      const before = await decoder.decode({ ...frame, positionSeconds: position });
      const after = await decoder.decode({ ...frame, positionSeconds: before.positionSeconds, after: true });
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

  it('decodes queued clock frames in order and cancels obsolete queued work', async () => {
    const queue = new DecoderQueue(workerPath, process.env.COMMS_TEST_FFMPEG!);
    const order: string[] = [];
    try {
      const first = queue.frame(frame).then(() => { order.push('first'); });
      const later = queue.frame(frame).then(() => { order.push('later'); });
      const clock = queue.frame(frame).then(result => { expect(result.png).toBeInstanceOf(Uint8Array); order.push('frame'); });
      const abort = new AbortController();
      const obsolete = queue.frame(frame, abort.signal); abort.abort();
      await expect(obsolete).rejects.toThrow('cancelled');
      await Promise.all([first, later, clock]);
      expect(order).toEqual(['first', 'later', 'frame']);
    } finally { await queue.close(); }
  });
});
