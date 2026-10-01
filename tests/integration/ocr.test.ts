import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcrReader } from '../../src/analysis/ocr-client';
import { parseClock } from '../../src/analysis/clock-fit';
import { VideoClockAnalyzer } from '../../src/analysis/video-clock';
import { DecoderQueue } from '../../src/analysis/decoder-client';
import { fileVersion } from '../../src/library/identity';

describe.skipIf(!existsSync('resources/ocr/verified.json'))('packaged offline clock reader', () => {
  let folder: string, workerPath: string, png: Buffer;
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'comms-ocr-')); workerPath = join(folder, 'ocr.cjs');
    await build({ entryPoints: [resolve('src/analysis/ocr-entry.ts')], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
    png = await readFile('tests/fixtures/ocr/clock.png');
  });
  afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

  it('reads local clock images with a reused worker and does not invent a clock on a blank image', async () => {
    const reader = new OcrReader(workerPath, resolve('resources/ocr'));
    try {
      const first = await reader.read(png);
      expect(parseClock(first.text)).toBe(754); expect(first.confidence).toBeGreaterThanOrEqual(40);
      const rollover = await reader.read(await readFile('tests/fixtures/ocr/rollover.png'));
      expect(parseClock(rollover.text)).toBe(3600);
      expect(parseClock((await reader.read(await readFile('tests/fixtures/ocr/blank.png'))).text)).toBeUndefined();
    } finally { await reader.close(); }
  // Startup and the three recognitions each keep the reader's 15-second deadline.
  // The fixture allowance must include all four exchanges and worker cleanup.
  }, 65000);
  it('cancels active recognition, recovers on the next request, and closes without pending work', async () => {
    const reader = new OcrReader(workerPath, resolve('resources/ocr'));
    try {
      await reader.read(png);
      const abort = new AbortController();
      const cancelled = reader.read(png, abort.signal);
      const timer = setTimeout(() => abort.abort(), 1);
      try { await expect(cancelled).rejects.toThrow(); } finally { clearTimeout(timer); }
      expect(parseClock((await reader.read(png)).text)).toBe(754);
    } finally { await reader.close(); }
    await expect(reader.read(png)).rejects.toThrow('cancelled');
  });
  it('fails on missing local assets and kills an unresponsive worker within its deadline', async () => {
    const missing = new OcrReader(workerPath, folder);
    try { await expect(missing.read(png)).rejects.toThrow(); } finally { await missing.close(); }
    const hanging = join(folder, 'hanging.cjs');
    await writeFile(hanging, "require('node:worker_threads').parentPort.on('message', () => {});");
    const stalled = new OcrReader(hanging, folder, 200);
    try { await expect(stalled.read(png)).rejects.toThrow('timed out'); } finally { await stalled.close(); }
  });
  it('rejects damaged local language data instead of downloading a replacement or hanging', async () => {
    const damaged = join(folder, 'damaged');
    await cp('resources/ocr', damaged, { recursive: true });
    await writeFile(join(damaged, 'eng.traineddata.gz'), Buffer.from([0x1f, 0x8b, 0x00]));
    const reader = new OcrReader(workerPath, damaged, 5000);
    try { await expect(reader.read(png)).rejects.toThrow('offline clock resources'); } finally { await reader.close(); }
  // Copying the complete WASM fixture is not part of the reader's five-second
  // failure deadline, especially while a release verifier is reading large files.
  }, 60000);
  it.skipIf(!process.env.COMMS_TEST_FFMPEG)('decodes and aligns the synthetic video through real FFmpeg, OCR, and adjacent-frame midpoint', async () => {
    const decoderPath = join(folder, 'decoder.cjs');
    await build({ entryPoints: [resolve('src/analysis/decoder-entry.ts')], outfile: decoderPath, bundle: true, platform: 'node', format: 'cjs' });
    const decoder = new DecoderQueue(decoderPath, process.env.COMMS_TEST_FFMPEG!);
    const reader = new OcrReader(workerPath, resolve('resources/ocr'));
    const path = join(folder, 'top-right clock.mkv');
    await promisify(execFile)(process.env.COMMS_TEST_FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-i', resolve('tests/fixtures/ocr/clock-video.mkv'),
      '-t', '4', '-vf', 'scale=68:26:flags=lanczos,pad=1920:1080:1852:0:color=0x111827', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '1', '-output_ts_offset', '5', path]);
    try {
      const result = await new VideoClockAnalyzer(decoder, reader).analyze({ path, version: await fileVersion(path), streamIndex: 0, originSeconds: 5,
        startSeconds: 0, endSeconds: 4,
      });
      expect(result.fit.status, JSON.stringify(result.fit)).toBe('accepted');
      if (result.fit.status !== 'accepted') throw new Error('Expected synthetic fit');
      expect(Math.abs(result.fit.offsetSeconds + 100)).toBeLessThan(result.fit.uncertaintySeconds);
      expect(result.fit.uncertaintySeconds).toBeLessThan(0.05);
      expect(result.fit.evidence.algorithmVersion).toBe(2);
      expect(result.readings).toHaveLength(2);
      expect(result.framesRead).toBeLessThanOrEqual(150);
    } finally { await decoder.close(); await reader.close(); }
  }, 60000);
});
