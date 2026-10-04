import { defaultFilters } from '../src/shared/filters';
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

async function workerFixture(overrides: { filters?: () => Promise<void>; interrupt?: () => void } = {}) {
  const bundle = await build({ entryPoints: ['src/sync/entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'heartbeat-fixtures', setup(builder) {
      builder.onResolve({ filter: /^\.\/(engine|filtered-engine|replay)$/ }, args => args.importer.endsWith('/sync/entry.ts') ? { path: args.path, namespace: 'fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === './replay'
        ? 'export class LocalReplayTransport {} export class ReplayConnection { start() {} stop() {} }'
        : args.path === './filtered-engine' ? 'export class FilteredEngine { constructor() { return globalThis.testEngine; } }' : 'export class MediaEngine {}' }));
    } }], footer: { js: `module.exports = { state: () => recovery.state, alignment: () => snapshot.offsetSeconds, seed: () => { snapshot.offsetSeconds = 12; boundSession = 'fixture'; }, closing: () => closing };` } });
  let now = 0, tick: () => void = () => {}, receive: (event: { data: unknown }) => void = () => {};
  const replies: { type: string; id?: number; error?: string }[] = [];
  const interruptions: string[] = [], exits: number[] = [];
  const sandbox = createContext({ require: createRequire(import.meta.url), module: { exports: {} }, Buffer, structuredClone,
    performance: { now: () => now * 1000 }, setTimeout, clearTimeout,
    setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {},
    process: { argv: ['node', 'entry', resolve('resources')], platform: 'linux', exit: (code: number) => exits.push(code),
      parentPort: { on: (_: string, callback: typeof receive) => { receive = callback; }, postMessage(message: typeof replies[number]) { replies.push(message); } } },
    testEngine: { outputState: () => ({ revision: 1, devices: [] }), interrupt: (reason: string) => { interruptions.push(reason); overrides.interrupt?.(); }, filters: overrides.filters ?? (async () => {}), close: async () => {} },
  });
  runInContext(bundle.outputFiles[0]!.text, sandbox);
  const worker = sandbox.module.exports as { state(): string; alignment(): number | undefined; seed(): void; closing(): boolean };
  worker.seed();
  return { worker, interruptions, exits, replies, send: (data: unknown) => receive({ data }),
    advance: (seconds: number) => { const end = now + seconds; while (now < end) { now = Math.min(end, now + .05); tick(); } },
    settle: () => new Promise<void>(resolve => setImmediate(resolve)) };
}

it('silences a stalled parent without exiting, then recovers with its alignment intact', async () => {
  const fixture = await workerFixture();
  fixture.advance(2.5);
  expect(fixture.worker.state()).toBe('suspended');
  expect(fixture.interruptions).toEqual(['Application response was interrupted']);
  expect(fixture.exits).toEqual([]);
  expect(fixture.worker.alignment()).toBe(12);
  fixture.advance(5);
  expect(fixture.interruptions).toHaveLength(1);
  fixture.send({ type: 'heartbeat' });
  await fixture.settle();
  expect(fixture.worker.state()).toBe('active');
  expect(fixture.worker.alignment()).toBe(12);
  expect(fixture.exits).toEqual([]);
  fixture.advance(1);
  expect(fixture.worker.state()).toBe('active');
});

it('eventually closes an orphaned worker when the parent remains absent', async () => {
  const fixture = await workerFixture();
  fixture.advance(31);
  await fixture.settle();
  expect(fixture.worker.closing()).toBe(true);
  expect(fixture.exits).toEqual([0]);
});

it('does not resume output on a heartbeat while the system is suspended', async () => {
  const fixture = await workerFixture();
  fixture.advance(2.5);
  fixture.send({ type: 'power', sequence: 1, state: 'suspend' });
  fixture.send({ type: 'heartbeat' });
  await fixture.settle();
  expect(fixture.worker.state()).toBe('suspended');
  fixture.send({ type: 'power', sequence: 2, state: 'resume' });
  await fixture.settle();
  expect(fixture.worker.state()).toBe('active');
  expect(fixture.exits).toEqual([]);
});


it('discards canceled queued commands without applying them or interrupting healthy playback', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await workerFixture({ filters: async () => { calls++; await gate; } });
  fixture.send({ id: 1, command: { type: 'filters', filters: defaultFilters() } });
  await fixture.settle();
  fixture.send({ id: 2, command: { type: 'filters', filters: defaultFilters() } });
  fixture.send({ type: 'cancel', id: 2 });
  release(); await fixture.settle();
  expect(calls).toBe(1);
  expect(fixture.interruptions).toEqual([]);
  expect(fixture.replies).toContainEqual({ type: 'reply', id: 2, error: 'Playback operation timed out' });
});

it('interrupts canceled active work before recovering and never acknowledges it as successful', async () => {
  let reject!: (error: Error) => void;
  const work = new Promise<void>((_, fail) => { reject = fail; });
  const fixture = await workerFixture({ filters: () => work, interrupt: () => reject(new Error('Interrupted')) });
  fixture.send({ id: 1, command: { type: 'filters', filters: defaultFilters() } });
  await fixture.settle();
  fixture.send({ type: 'cancel', id: 1 });
  await fixture.settle();
  expect(fixture.interruptions).toContain('Playback operation timed out');
  expect(fixture.replies.some(reply => reply.id === 1 && reply.error !== undefined)).toBe(true);
  expect(fixture.worker.state()).toBe('active');
});

it('rejects an expired deadline before executing a playback command', async () => {
  let calls = 0;
  const fixture = await workerFixture({ filters: async () => { calls++; } });
  fixture.send({ id: 1, deadline: Date.now() - 1, command: { type: 'filters', filters: defaultFilters() } });
  await fixture.settle();
  expect(calls).toBe(0);
  expect(fixture.replies).toContainEqual({ type: 'reply', id: 1, error: 'Playback operation timed out' });
});
