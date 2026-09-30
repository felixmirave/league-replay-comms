import { waveformSchema, type WaveformChunk } from '../shared/analysis';
import { digestSchema } from './model';
import { DerivedCache } from './derived-cache';

export interface WaveformCacheKey { hash: string; streamIndex: number; originSeconds: number; startSeconds: number; endSeconds: number; bucketSeconds: number; sampleRate: number }
/** Disposable previews live separately from durable replay associations. */
export class AnalysisCache {
  private readonly cache: DerivedCache;
  constructor(directory: string, maxBytes = 256 * 1024 * 1024) { this.cache = new DerivedCache(directory, maxBytes); }
  async get(key: WaveformCacheKey): Promise<WaveformChunk | undefined> {
    return this.cache.get(this.key(key), raw => {
      const value = waveformSchema.parse(raw);
      if (value.startSeconds !== key.startSeconds || value.endSeconds !== key.endSeconds || Math.abs(value.bucketSeconds - key.bucketSeconds) > 1 / key.sampleRate) throw new Error('Waveform cache window mismatch');
      return value;
    });
  }
  put(key: WaveformCacheKey, value: WaveformChunk): Promise<void> {
    return this.cache.put(this.key(key), waveformSchema.parse(value));
  }
  async flush(): Promise<void> { await this.cache.flush(); }
  private key(key: WaveformCacheKey): unknown[] {
    digestSchema.parse(key.hash);
    return ['waveform', 1, 1, key.hash, key.streamIndex, key.originSeconds, key.startSeconds, key.endSeconds, key.bucketSeconds, key.sampleRate];
  }
}
