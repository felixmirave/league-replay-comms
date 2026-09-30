import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CachedClockAnalysis } from '../src/analysis/cached-clock';
import { fitClock, type ClockReading } from '../src/analysis/clock-fit';
import type { VideoClockJobs, VideoClockRequest, VideoClockResult } from '../src/analysis/video-clock';
import { ClockCache } from '../src/library/clock-cache';
import { identifyFile } from '../src/library/identity';

let folder: string, request: VideoClockRequest;
const crop = { x: 0.9, y: 0, width: 0.1, height: 0.05 };
const observations: ClockReading[] = [
  { mediaSeconds: 103.254, clockSeconds: 99, confidence: 90 },
  { mediaSeconds: 103.287, clockSeconds: 100, confidence: 90 },
];
class Analyzer implements VideoClockJobs {
  calls: VideoClockRequest[] = [];
  async analyze(request: VideoClockRequest): Promise<VideoClockResult> {
    this.calls.push(request);
    return { crop: request.crop ?? crop, fit: fitClock(observations), readings: observations, framesRead: observations.length };
  }
}
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'comms-clock-cache-'));
  const path = join(folder, 'recording.mkv'); await writeFile(path, 'test recording identity');
  const identity = await identifyFile(path);
  request = { path, version: identity.version, hash: identity.sha256, streamIndex: 0, originSeconds: 0, startSeconds: 0, endSeconds: 900 };
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
const cache = (runtime = 'runtime-a') => new ClockCache(join(folder, 'cache'), runtime);

describe('clock cache and identity promotion', () => {
  it('reuses a localized clock after rename, including its remembered crop and midpoint', async () => {
    const analyzer = new Analyzer(), first = new CachedClockAnalysis(analyzer, cache());
    await first.analyze(request); await first.flush();
    const renamed = join(folder, 'renamed café.mkv'); await rename(request.path, renamed);
    const identity = await identifyFile(renamed);
    const next = new CachedClockAnalysis(analyzer, cache());
    const restored = await next.analyze({ ...request, path: renamed, version: identity.version, crop });
    expect(restored.fromCache).toBe(true); expect(restored.fit.status).toBe('accepted');
    if (restored.fit.status === 'accepted') expect(restored.fit.offsetSeconds).toBeCloseTo(3.2705);
    expect(analyzer.calls).toHaveLength(1);
  });
  it('isolates stream, timeline origin, window, crop and runtime and honors explicit re-runs', async () => {
    const analyzer = new Analyzer(), service = new CachedClockAnalysis(analyzer, cache());
    await service.analyze(request); await service.flush();
    for (const change of [{ streamIndex: 1 }, { originSeconds: 5 }, { endSeconds: 950 }, { crop: { ...crop, y: 0.01 } }, { force: true }]) await service.analyze({ ...request, ...change });
    await service.flush();
    const otherRuntime = new CachedClockAnalysis(analyzer, cache('runtime-b'));
    await otherRuntime.analyze(request); await otherRuntime.flush();
    expect(analyzer.calls).toHaveLength(7);
  });
  it.each(['before', 'after'])('promotes provisional evidence when identity finishes %s analysis', async when => {
    const analyzer = new Analyzer();
    let started!: () => void, complete!: (result: VideoClockResult) => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    analyzer.analyze = async () => { started(); return new Promise(resolve => { complete = resolve; }); };
    const service = new CachedClockAnalysis(analyzer, cache());
    const pendingRequest = { ...request, hash: undefined, importId: 'pending-import' };
    const job = service.analyze(pendingRequest); await ready;
    if (when === 'before') await service.identify('pending-import', await identifyFile(request.path));
    complete(await new Analyzer().analyze(request)); await job;
    if (when === 'after') await service.identify('pending-import', await identifyFile(request.path));
    await service.flush();
    const fresh = new Analyzer();
    const restored = await new CachedClockAnalysis(fresh, cache()).analyze({ ...request, crop });
    expect(restored.fromCache).toBe(true); expect(fresh.calls).toHaveLength(0);
  });
  it('does not promote evidence for a different source version, and refuses a replaced source on lookup', async () => {
    const service = new CachedClockAnalysis(new Analyzer(), cache());
    await service.analyze({ ...request, hash: undefined, importId: 'pending' });
    await writeFile(request.path, 'replacement recording');
    await service.identify('pending', await identifyFile(request.path)); await service.flush();
    await expect(service.analyze(request)).rejects.toThrow('changed');
    const fresh = new Analyzer(), identity = await identifyFile(request.path);
    const changedSource = new CachedClockAnalysis(fresh, cache());
    await changedSource.analyze({ ...request, version: identity.version, hash: identity.sha256 }); await changedSource.flush();
    expect(fresh.calls).toHaveLength(1);
  });
  it('treats corrupt or mismatched cache descriptors as misses and keeps review usable on cache write failure', async () => {
    const analyzer = new Analyzer(), service = new CachedClockAnalysis(analyzer, cache());
    await service.analyze({ ...request, crop }); await service.flush();
    const directory = join(folder, 'cache'), file = join(directory, (await readdir(directory))[0]!);
    const raw = JSON.parse(await readFile(file, 'utf8')); raw.key = 'another recording';
    await writeFile(file, JSON.stringify(raw));
    expect((await service.analyze({ ...request, crop })).fromCache).toBeUndefined(); await service.flush();
    await writeFile(file, '{broken');
    expect((await service.analyze({ ...request, crop })).fromCache).toBeUndefined(); await service.flush();
    await rm(directory, { recursive: true }); await writeFile(directory, 'not a directory');
    const result = await service.analyze({ ...request, crop, force: true }); await service.flush();
    expect(result.fit.status).toBe('accepted');
  });
  it('evicts only derived artifacts and never serves cancelled lookups', async () => {
    const directory = join(folder, 'cache');
    const service = new CachedClockAnalysis(new Analyzer(), new ClockCache(directory, 'runtime-a', 1));
    await service.analyze(request); await service.flush();
    await writeFile(join(directory, 'library.json'), 'durable data');
    await service.analyze(request); await service.flush();
    expect(await readdir(directory)).toEqual(['library.json']);
    const abort = new AbortController(); abort.abort();
    await expect(service.analyze(request, abort.signal)).rejects.toThrow();
  });
});
