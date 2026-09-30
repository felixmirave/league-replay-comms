import { z } from 'zod';
import { clockReadingSchema } from '../shared/clock';
import { cropSchema } from '../shared/geometry';
import { clockAnalysisVersion, type VideoClockRequest } from '../analysis/video-clock';
import { digestSchema } from './model';
import { DerivedCache } from './derived-cache';

const evidenceSchema = z.object({ crop: cropSchema, readings: z.array(clockReadingSchema).length(2), framesRead: z.number().int().min(0).max(5000) });
export type CachedClockEvidence = z.infer<typeof evidenceSchema>;
type Key = VideoClockRequest & { hash: string };

/** Stores the consecutive-frame pair; the midpoint is recomputed when restored. */
export class ClockCache {
  private readonly cache: DerivedCache;
  constructor(directory: string, private readonly runtimeId: string, maxBytes = 64 * 1024 * 1024) { this.cache = new DerivedCache(directory, maxBytes); }
  get(key: Key): Promise<CachedClockEvidence | undefined> {
    return this.cache.get(this.key(key), raw => {
      const value = evidenceSchema.parse(raw);
      if (value.readings.some(reading => reading.mediaSeconds < key.startSeconds || reading.mediaSeconds >= key.endSeconds)) throw new Error('Clock evidence is outside its recording window');
      if (key.crop && JSON.stringify(value.crop) !== JSON.stringify(cropSchema.parse(key.crop))) throw new Error('Clock evidence has a different crop');
      return value;
    });
  }
  put(key: Key, value: CachedClockEvidence): Promise<void> { return this.cache.put(this.key(key), evidenceSchema.parse(value)); }
  flush(): Promise<void> { return this.cache.flush(); }
  private key(key: Key): unknown[] {
    digestSchema.parse(key.hash);
    const crop = key.crop && cropSchema.parse(key.crop);
    return ['video-clock', clockAnalysisVersion, 1, this.runtimeId, key.hash, key.streamIndex, key.originSeconds, key.startSeconds, key.endSeconds, crop ? [crop.x, crop.y, crop.width, crop.height] : null];
  }
}
