import { resolve } from 'node:path';
import { fileVersion } from '../library/identity';
import { sameFileVersion, type FileIdentity, type FileVersion } from '../library/model';
import { ClockCache, type CachedClockEvidence } from '../library/clock-cache';
import { fitClock } from './clock-fit';
import type { ClockProgress, VideoClockJobs, VideoClockRequest, VideoClockResult } from './video-clock';

interface Pending { path: string; version: FileVersion; hash?: string; completed: { request: VideoClockRequest; evidence: CachedClockEvidence }[] }
/** Keeps provisional evidence private until the import is identified and validated. */
export class CachedClockAnalysis implements VideoClockJobs {
  private pending = new Map<string, Pending>();
  private writes = new Set<Promise<void>>();
  constructor(private readonly analyzer: VideoClockJobs, private readonly cache: ClockCache) {}

  async analyze(request: VideoClockRequest, signal?: AbortSignal, progress?: (value: ClockProgress) => void): Promise<VideoClockResult> {
    signal?.throwIfAborted();
    await this.checkSource(request);
    let pending: Pending | undefined;
    if (!request.hash && request.importId) {
      pending = this.pending.get(request.importId);
      if (pending && (resolve(request.path) !== pending.path || !sameFileVersion(pending.version, request.version))) throw new Error('Provisional clock source changed');
      if (!pending) {
        pending = { path: resolve(request.path), version: request.version, completed: [] };
        this.pending.set(request.importId, pending);
        // Cancellation/failed identity must not grow an unbounded in-memory cache.
        while (this.pending.size > 16) this.pending.delete(this.pending.keys().next().value!);
      }
    }
    if (request.hash && !request.force) {
      const cached = await this.cache.get({ ...request, hash: request.hash });
      signal?.throwIfAborted();
      if (cached) {
        const fit = fitClock(cached.readings);
        if (fit.status !== 'needs-attention') {
          await this.checkSource(request); signal?.throwIfAborted();
          return { ...cached, fit, fromCache: true };
        }
      }
    }
    const result = await this.analyzer.analyze(request, signal, progress);
    await this.checkSource(request); signal?.throwIfAborted();
    if (result.crop && result.fit.status !== 'needs-attention') {
      const evidence = { crop: result.crop, readings: result.readings, framesRead: result.framesRead };
      const hash = request.hash ?? pending?.hash;
      if (hash) this.save({ ...request, hash }, evidence);
      else if (pending && this.pending.get(request.importId!) === pending) {
        pending.completed.push({ request: structuredClone(request), evidence: structuredClone(evidence) });
        if (pending.completed.length > 4) pending.completed.shift();
      }
    }
    return result;
  }
  async identify(importId: string, identity: FileIdentity): Promise<void> {
    const pending = this.pending.get(importId);
    if (!pending) return;
    if (pending.path !== resolve(identity.path) || !sameFileVersion(pending.version, identity.version)) { this.pending.delete(importId); return; }
    if (!sameFileVersion(identity.version, await fileVersion(identity.path))) { this.pending.delete(importId); return; }
    pending.hash = identity.sha256;
    this.pending.delete(importId);
    for (const item of pending.completed) this.save({ ...item.request, hash: identity.sha256 }, item.evidence);
    pending.completed = [];
  }
  async flush(): Promise<void> { while (this.writes.size) await Promise.all([...this.writes]); await this.cache.flush(); }
  private save(request: VideoClockRequest & { hash: string }, evidence: CachedClockEvidence): void {
    // A disposable cache failure cannot invalidate the in-memory result or an offset.
    const operation = Promise.resolve().then(() => this.cache.put(request, evidence)).catch(() => undefined).finally(() => this.writes.delete(operation));
    this.writes.add(operation);
  }
  private async checkSource(request: VideoClockRequest): Promise<void> {
    if (!sameFileVersion(request.version, await fileVersion(request.path))) throw new Error('Recording changed during clock analysis. Reopen it.');
  }
}
