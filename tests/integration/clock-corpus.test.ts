import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecoderQueue } from '../../src/analysis/decoder-client';
import { OcrReader } from '../../src/analysis/ocr-client';
import { VideoClockAnalyzer } from '../../src/analysis/video-clock';
import { fileVersion } from '../../src/library/identity';
import corpus from '../fixtures/ocr/real/manifest.json';

// These are full, independently labeled frames: no test crop, preprocessing,
// fake OCR, or expected-failure exceptions. Missing prerequisites must fail.
describe('production clock detection on reviewed League screenshots', () => {
  let folder: string, decoder: DecoderQueue, reader: OcrReader, detector: VideoClockAnalyzer;
  beforeAll(async () => {
    await readFile('resources/ocr/verified.json'); // npm run prepare:ocr
    folder = await mkdtemp(join(tmpdir(), 'comms-clock-corpus-'));
    await build({ entryPoints: ['src/analysis/ocr-entry.ts', 'src/analysis/decoder-entry.ts'], outdir: folder,
      outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
    const ffmpeg = process.env.COMMS_TEST_FFMPEG ?? (process.platform === 'win32' ? resolve('resources/bin/win32-x64/ffmpeg.exe') : 'ffmpeg');
    decoder = new DecoderQueue(join(folder, 'decoder-entry.cjs'), ffmpeg);
    reader = new OcrReader(join(folder, 'ocr-entry.cjs'), resolve('resources/ocr'));
    detector = new VideoClockAnalyzer(decoder, reader);
  }, 30000);
  afterAll(async () => {
    try { await decoder?.close(); } finally {
      try { await reader?.close(); } finally { if (folder) await rm(folder, { recursive: true, force: true }); }
    }
  });

  it.each(corpus.samples)('$id — expected $expectedClock', async sample => {
    const path = resolve(sample.path);
    expect(createHash('sha256').update(await readFile(path)).digest('hex'), 'Original fixture changed').toBe(sample.sha256);
    const result = await detector.readFrame({ path, version: await fileVersion(path), streamIndex: 0, originSeconds: 0, positionSeconds: 0 });
    // Expected seconds come from reviewed labels, not the production parser.
    const [minutes, seconds] = (sample.expectedClock ?? '').split(':').map(Number);
    const expected = sample.expectedClock === null ? undefined : minutes! * 60 + seconds!;
    expect(result.clockSeconds, JSON.stringify({ text: result.text, confidence: result.confidence })).toBe(expected);
  }, 45000);
});
