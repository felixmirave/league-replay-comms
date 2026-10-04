import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { AudioSample, ControllerEvent, ReplaySample, SyncStatus } from '../src/shared/domain';
import { defaultFilters } from '../src/shared/filters';

it('applies filters during a seek without blocking replay updates or the next large jump', async () => {
  const bundle = await build({ entryPoints: ['src/sync/entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'engine-fixtures', setup(builder) {
      builder.onResolve({ filter: /^\.\/(engine|filtered-engine|replay)$/ }, args => args.importer.endsWith('/sync/entry.ts') ? { path: args.path, namespace: 'fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === './replay'
        ? 'export class LocalReplayTransport {} export class ReplayConnection { constructor(_, sample) { globalThis.emitReplay = sample; } start() {} stop() {} }'
        : args.path === './filtered-engine' ? 'export class FilteredEngine { constructor() { return globalThis.testEngine; } }' : 'export class MediaEngine {}' }));
    } }], footer: { js: `module.exports = { dispatch, handle, currentSnapshot, status: () => controller.snapshot(), markFailed: () => { recovery.state = 'failed'; snapshot.error = 'Recording changed'; }, setMedia: () => { snapshot.media = { name: 'fixture', durationSeconds: 1800, selectedTrackId: 1, tracks: [] }; } };` } });
  let now = 0, filterCalls = 0;
  let receive: (message: unknown) => void = () => {};
  const replies: unknown[] = [];
  const seeks: { seconds: number; finish: (sample: AudioSample) => void }[] = [];
  let sample: AudioSample = { positionSeconds: 0, paused: true, seeking: false, rate: 1, observedAtSeconds: 0, uncertaintySeconds: 0 };
  const sandbox = createContext({ require: createRequire(import.meta.url), module: { exports: {} }, Buffer, structuredClone,
    performance: { now: () => now * 1000 }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    process: { argv: ['node', 'entry', resolve('resources')], platform: 'linux', parentPort: { on(event: string, callback: (message: unknown) => void) { if (event === 'message') receive = callback; }, postMessage(message: unknown) { replies.push(message); } } },
    testEngine: { outputState: () => ({ revision: 1, devices: [] }),
      seek: (seconds: number) => new Promise<AudioSample>(finish => seeks.push({ seconds, finish: value => { sample = value; finish(value); } })),
      filters: async () => { filterCalls++; }, pause: async () => {}, rate: async () => {}, observe: async () => sample },
  });
  runInContext(bundle.outputFiles[0]!.text, sandbox);
  const worker = sandbox.module.exports as { dispatch(event: ControllerEvent): void; handle(request: unknown): Promise<unknown>; status(): SyncStatus; currentSnapshot(): { busy: boolean; error?: string }; setMedia(): void; markFailed(): void };
  const replay = (time: number): ReplaySample => ({ sessionId: 'fixture', timeSeconds: time, speed: 1, paused: false, seeking: false, lengthSeconds: 1800, sentAtSeconds: now, receivedAtSeconds: now });
  const emit = (time: number) => (sandbox.emitReplay as (sample: ReplaySample) => void)(replay(time));
  worker.setMedia(); emit(0);
  worker.dispatch({ type: 'bind', binding: { replaySessionId: 'fixture', offsetSeconds: 0, startSeconds: 0, endSeconds: 1800 } });
  worker.dispatch({ type: 'mode', mode: 'follow' });
  now = .1; emit(.1);
  expect(seeks).toHaveLength(1);
  const edit = worker.handle({ id: 1, command: { type: 'filters', filters: defaultFilters() } });
  expect(worker.currentSnapshot().busy).toBe(false);
  expect(filterCalls).toBe(1); // The graph edit does not wait for raw decoding.
  now = .2; emit(1000);
  seeks[0]!.finish({ ...sample, positionSeconds: seeks[0]!.seconds, observedAtSeconds: now });
  await edit;
  expect(filterCalls).toBe(1);
  expect(worker.currentSnapshot().busy).toBe(false);
  expect(seeks).toHaveLength(2); // The completed old seek no longer blocks this jump.
  seeks[1]!.finish({ ...sample, positionSeconds: seeks[1]!.seconds, observedAtSeconds: now });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(worker.status().state).toBe('following');
  now = .3; emit(1000.1);
  now = 31; emit(1030.8);
  worker.dispatch({ type: 'audio', sample: { ...sample, paused: false, positionSeconds: 1030.8, observedAtSeconds: now } });
  expect(worker.status().state).not.toBe('error');

  // Reopening after failed recovery applies filters before the replacement load.
  // Exercise the queued parent request, including its failed-state guard.
  worker.markFailed();
  receive({ data: { id: 2, command: { type: 'filters', filters: defaultFilters() } } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(filterCalls).toBe(2);
  expect(replies).toContainEqual(expect.objectContaining({ type: 'reply', id: 2, data: expect.anything() }));
  expect(worker.currentSnapshot().error).toBe('Recording changed');
});
