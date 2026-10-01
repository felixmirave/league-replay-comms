import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewSession, type PreviewSource } from '../src/main/preview-session';
import { AnalysisCache } from '../src/library/analysis-cache';
import type { AnalysisDecoder } from '../src/analysis/decoder-client';
import type { WaveformChunk, WaveformRequest } from '../src/shared/analysis';

let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'comms-previews-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
const hash = 'a'.repeat(64);
function source(video = false): PreviewSource {
  return { path: 'recording.mkv', version: { size: 1, mtimeNs: '1', ctimeNs: '1', device: '1', inode: '1' }, media: { name: 'recording.mkv', durationSeconds: 150, originSeconds: 5, selectedTrackId: 1,
    tracks: [{ id: 1, ffIndex: 0, title: 'Comms', selected: true }, { id: 2, ffIndex: 2, title: 'Microphone', selected: false }],
    probe: { formats: ['matroska'], streams: [{ type: 'audio', index: 0, codec: 'aac', sampleRate: 48000 }, { type: 'audio', index: 2, codec: 'aac', sampleRate: 48000 }, ...(video ? [{ type: 'video' as const, index: 1, codec: 'h264', startPtsSeconds: 5 }] : [])] } } };
}
class Decoder implements AnalysisDecoder {
  waves: WaveformRequest[] = [];
  frame = vi.fn<AnalysisDecoder['frame']>().mockRejectedValue(new Error('Waveform preview must not decode video frames'));
  async waveform(request: WaveformRequest): Promise<WaveformChunk> {
    this.waves.push(request);
    return { kind: 'waveform', startSeconds: request.startSeconds, endSeconds: request.endSeconds, bucketSeconds: request.bucketSeconds, peaks: [[request.startSeconds, request.endSeconds, -0.5, 0.5]] };
  }
}

describe('preview sessions and disposable caches', () => {
  it('builds bounded chunks, promotes a provisional waveform after hashing, and reuses it after a rename', async () => {
    const decoder = new Decoder(), cache = new AnalysisCache(folder);
    const first = new PreviewSession(decoder, cache, () => {});
    first.select(source()); await first.settled();
    expect(decoder.waves.map(item => [item.startSeconds, item.endSeconds])).toEqual([[0, 60], [60, 120], [120, 150]]);
    expect(first.snapshot().waveform?.complete).toBe(true);
    first.identify(hash); await first.settled();
    const otherDecoder = new Decoder();
    const next = new PreviewSession(otherDecoder, cache, () => {});
    next.select({ ...source(), path: 'renamed.mkv', hash }); await next.settled();
    expect(otherDecoder.waves).toHaveLength(0);
    expect(next.snapshot().waveform?.peaks).toEqual(first.snapshot().waveform?.peaks);
    next.waveformWindow(10, 20); await next.settled();
    expect(otherDecoder.waves).toHaveLength(1);
    expect(next.snapshot().waveform?.startSeconds).toBe(10);
  });

  it('keeps waveform caches separate for different audio tracks and player origins', async () => {
    const cache = new AnalysisCache(folder), decoder = new Decoder();
    const session = new PreviewSession(decoder, cache, () => {});
    const original = { ...source(), hash };
    session.select(original); await session.settled();
    session.select({ ...original, media: { ...original.media, selectedTrackId: 2 } }); await session.settled();
    expect(decoder.waves.slice(-3).every(wave => wave.streamIndex === 2)).toBe(true);
    session.select({ ...original, media: { ...original.media, originSeconds: 0 } }); await session.settled();
    expect(decoder.waves).toHaveLength(9);
  });

  it('prepares only audio waveforms for video recordings, including track changes', async () => {
    const decoder = new Decoder(), session = new PreviewSession(decoder, new AnalysisCache(folder), () => {});
    const original = source(true);
    session.select(original); await session.settled();
    expect(session.snapshot().waveform?.complete).toBe(true);
    session.select({ ...original, media: { ...original.media, selectedTrackId: 2 } }); await session.settled();
    expect(decoder.frame).not.toHaveBeenCalled();
    expect(decoder.waves.slice(-3).every(wave => wave.streamIndex === 2)).toBe(true);
  });

  it('ignores a late waveform from the previous recording', async () => {
    let finish!: (value: WaveformChunk) => void;
    const decoder = new Decoder(), wave = decoder.waveform.bind(decoder);
    decoder.waveform = request => request.path === 'recording.mkv' ? new Promise(resolve => { finish = resolve; }) : wave(request);
    const session = new PreviewSession(decoder, new AnalysisCache(folder), () => {});
    session.select(source());
    session.select({ ...source(), path: 'other.wav' });
    finish({ kind: 'waveform', startSeconds: 0, endSeconds: 60, bucketSeconds: 1, peaks: [[0, 60, -1, 1]] });
    await session.settled();
    expect(session.snapshot().waveform?.complete).toBe(true);
    expect(session.snapshot().waveform?.peaks.every(peak => peak[2] === -0.5)).toBe(true);
  });

  it('treats corrupt/future cache entries as misses and evicts only derived cache files', async () => {
    const cache = new AnalysisCache(folder);
    const key = { hash, streamIndex: 0, originSeconds: 0, sampleRate: 48000, startSeconds: 0, endSeconds: 1, bucketSeconds: 0.1 };
    const value: WaveformChunk = { kind: 'waveform', startSeconds: 0, endSeconds: 1, bucketSeconds: 0.1, peaks: [[0, 0.1, -0.5, 0.5]] };
    await cache.put(key, value);
    const path = join(folder, (await readdir(folder))[0]!);
    await writeFile(path, '{"version":99}'); expect(await cache.get(key)).toBeUndefined();
    await writeFile(path, '{partial'); expect(await cache.get(key)).toBeUndefined();
    await writeFile(join(folder, 'library.json'), 'durable data');
    await new AnalysisCache(folder, 1).put(key, value);
    expect(await readdir(folder)).toEqual(['library.json']);
  });
});
