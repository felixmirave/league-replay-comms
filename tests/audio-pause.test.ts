import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { defaultFilters } from '../src/shared/filters';
import type { AudioOperation, BrowserAudioSample } from '../src/shared/audio-engine';

let code: string;
beforeAll(async () => {
  const result = await build({ entryPoints: ['src/audio/player.ts'], bundle: true, write: false, format: 'iife',
    plugins: [{ name: 'graph-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/graph$/ }, () => ({ path: 'graph', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class FilterGraph { apply() {} setVolume() {} } export async function measureProtectionDelay() { return globalThis.protectionGate ? await globalThis.protectionGate : 0; }' }));
    } }],
  });
  code = result.outputFiles[0]!.text;
});

async function player(stallClean = false, closing: () => Promise<void> = async () => {}) {
  const messages: { type: string; epoch: number; frame?: number; clean?: boolean }[] = [];
  const workers: { noise: boolean; terminated: boolean; onerror?: (event: { message: string }) => void }[] = [];
  let closed = false;
  let receive: (event: { data: unknown }) => void;
  const sandbox = createContext({ performance, structuredClone, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    AudioContext: class {
      sampleRate = 48000; state = 'running'; currentTime = 1;
      audioWorklet = { addModule: async () => {} };
      getOutputTimestamp() { return { contextTime: 1, performanceTime: performance.now() }; }
      addEventListener() {} async resume() {} async close() {
        if (this.state === 'closed') throw new Error('AudioContext already closed');
        this.state = 'closed'; closed = true; await closing();
      }
    },
    AudioWorkletNode: class {
      port = { postMessage: (data: { type: string; epoch: number }) => { messages.push(data); },
        set onmessage(value: (event: { data: unknown }) => void) { receive = value; } };
      addEventListener() {}
    },
    Worker: class {
      onmessage?: (event: { data: unknown }) => void;
      noise = false;
      terminated = false;
      onerror?: (event: { message: string }) => void;
      constructor() { workers.push(this); }
      postMessage(data: { type: string; epoch: number; start: number; noise?: boolean }) {
        if (data.type === 'init') this.noise = data.noise === true;
        if (data.type === 'init' && !(data.noise && stallClean)) queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
        if (data.type === 'prepare') queueMicrotask(() => {
          for (let index = 0; index < 3; index++) {
            const raw = [new Float32Array(48000), new Float32Array(48000)];
            this.onmessage?.({ data: { type: 'chunk', epoch: data.epoch, start: Math.floor(data.start / 48000) * 48000 + index * 48000, from: data.start, length: 48000, raw: this.noise ? [] : raw, clean: this.noise ? new Float32Array(48000) : undefined } });
          }
        });
      }
      terminate() { this.terminated = true; }
    },
  });
  runInContext(code, sandbox);
  const engine = sandbox.audioEngine as { run(operation: AudioOperation & { source?: string }): Promise<BrowserAudioSample> };
  await engine.run({ type: 'load', path: 'fixture', source: 'http://fixture/pcm', audioIndex: 0, duration: 60, origin: 0 });
  await engine.run({ type: 'pause', paused: false });
  return { engine, messages, workers, closed: () => closed, protect: (gate: Promise<number>) => { sandbox.protectionGate = gate; }, acknowledge: (message: { epoch: number }, frame = 4800) => receive({ data: { type: 'paused', epoch: message.epoch, frame } }) };
}

it.each(['filters', 'seek'] as const)('waits for an in-flight pause before %s resets the worklet epoch', async type => {
  const { engine, messages, acknowledge } = await player();
  const before = messages.filter(message => message.type === 'reset').length;
  const pause = engine.run({ type: 'pause', paused: true });
  const settings = defaultFilters(); settings.noise.attenuation = 30;
  const edit = engine.run(type === 'filters' ? { type, filters: settings } : { type, seconds: 20 });
  const results = Promise.allSettled([pause, edit]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const resetBeforeAcknowledgement = messages.filter(message => message.type === 'reset').length !== before;
  const request = messages.find(message => message.type === 'pause')!;
  acknowledge(request);
  expect((await results).map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(resetBeforeAcknowledgement).toBe(false);
  const sample = await engine.run({ type: 'observe' });
  expect(sample.paused).toBe(true);
  expect(sample.positionSeconds).toBeCloseTo(type === 'filters' ? .1 : 20);
});

it('shares an acknowledgement between pause requests during seek preparation', async () => {
  const { engine, messages, acknowledge } = await player();
  // A filter rebuild or seek can already be marked as seeking when pause is requested.
  (engine as unknown as { seeking: boolean }).seeking = true;
  const first = engine.run({ type: 'pause', paused: true });
  const second = engine.run({ type: 'pause', paused: true });
  const results = Promise.allSettled([first, second]);
  const requests = messages.filter(message => message.type === 'pause');
  acknowledge(requests[0]!);
  expect((await results).map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(requests).toHaveLength(1);
});

it('matches the audible noise-suppression path after loading, toggling and seeking', async () => {
  const { engine, messages, acknowledge } = await player();
  expect(messages.filter(message => message.type === 'reference').at(-1)).toMatchObject({ clean: true, epoch: messages.filter(message => message.type === 'reset').at(-1)!.epoch });
  const settings = defaultFilters(); settings.noise.enabled = false;
  await engine.run({ type: 'filters', filters: settings });
  expect(messages.filter(message => message.type === 'reference').at(-1)).toMatchObject({ clean: false });
  const seek = engine.run({ type: 'seek', seconds: 20 });
  acknowledge(messages.filter(message => message.type === 'pause').at(-1)!);
  await seek;
  expect(messages.filter(message => message.type === 'reference').at(-1)).toMatchObject({ clean: false, epoch: messages.filter(message => message.type === 'reset').at(-1)!.epoch });
});

it('does not wait for suppression initialization before playing or seeking', async () => {
  const { engine, messages, acknowledge } = await player(true);
  expect((await engine.run({ type: 'observe' })).paused).toBe(false);
  const seek = engine.run({ type: 'seek', seconds: 20.123 });
  acknowledge(messages.filter(message => message.type === 'pause').at(-1)!);
  await seek;
  expect((await engine.run({ type: 'observe' })).positionSeconds).toBeCloseTo(20.123);
  await engine.run({ type: 'pause', paused: false });
  const sample = await engine.run({ type: 'observe' });
  expect(sample.paused).toBe(false);
  expect(Math.abs(sample.positionSeconds - 20.123)).toBeLessThan(.021);
});

it('changes suppression amount and toggles without pausing or resetting raw playback', async () => {
  const { engine, messages } = await player(true);
  const before = messages.filter(message => message.type === 'reset').length;
  const settings = defaultFilters(); settings.noise.attenuation = 40;
  await engine.run({ type: 'filters', filters: settings });
  settings.noise.enabled = false;
  await engine.run({ type: 'filters', filters: settings });
  expect((await engine.run({ type: 'observe' })).paused).toBe(false);
  expect(messages.filter(message => message.type === 'pause')).toHaveLength(0);
  expect(messages.filter(message => message.type === 'reset')).toHaveLength(before);
});

it('shares asynchronous cleanup when interruption and reopening overlap', async () => {
  let release!: () => void, closes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { engine, messages, acknowledge } = await player(true, async () => { closes++; await gate; });
  const first = engine.run({ type: 'interrupt' });
  const second = engine.run({ type: 'interrupt' });
  const load = engine.run({ type: 'load', path: 'fixture', source: 'http://fixture/pcm', audioIndex: 0, duration: 60, origin: 0 });
  const results = Promise.allSettled([first, second, load]);
  acknowledge(messages.filter(message => message.type === 'pause').at(-1)!);
  await new Promise<void>(resolve => setImmediate(resolve));
  const beforeRelease = closes;
  release();
  expect((await results).map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  expect(beforeRelease).toBe(1); expect(closes).toBe(1);
  expect((await engine.run({ type: 'observe' })).paused).toBe(true);
});


it('completes physical cleanup when the worklet does not acknowledge pause', async () => {
  const fixture = await player(true);
  await fixture.engine.run({ type: 'close' });
  expect(fixture.closed()).toBe(true);
  expect(fixture.workers.every(worker => worker.terminated)).toBe(true);
});

it('keeps original playback running when the suppression worker fails', async () => {
  const fixture = await player(true);
  const clean = fixture.workers.find(worker => worker.noise)!;
  clean.onerror!({ message: 'Model failure' });
  const sample = await fixture.engine.run({ type: 'observe' });
  expect(sample.paused).toBe(false);
  expect(sample.suppressionError).toContain('Model failure');
  expect(clean.terminated).toBe(true);
  expect(fixture.workers.find(worker => !worker.noise)!.terminated).toBe(false);
  expect(fixture.messages.filter(message => message.type === 'pause')).toHaveLength(0);
  const settings = defaultFilters(); settings.noise.enabled = false;
  await fixture.engine.run({ type: 'filters', filters: settings });
  expect((await fixture.engine.run({ type: 'observe' })).suppressionError).toBeUndefined();
});


it('prevents a canceled context initialization from later opening the recording', async () => {
  const fixture = await player(true);
  let release!: (delay: number) => void;
  fixture.protect(new Promise<number>(resolve => { release = resolve; }));
  const load = fixture.engine.run({ type: 'load', path: 'replacement', source: 'http://fixture/pcm', audioIndex: 0, duration: 60, origin: 0 });
  const result = Promise.allSettled([load]);
  fixture.acknowledge(fixture.messages.filter(message => message.type === 'pause').at(-1)!);
  await new Promise<void>(resolve => setImmediate(resolve));
  const workersBefore = fixture.workers.length;
  await fixture.engine.run({ type: 'interrupt' });
  release(0);
  expect((await result)[0]!.status).toBe('rejected');
  expect(fixture.workers).toHaveLength(workersBefore);
  await fixture.engine.run({ type: 'load', path: 'retry', source: 'http://fixture/pcm', audioIndex: 0, duration: 60, origin: 0 });
  expect((await fixture.engine.run({ type: 'observe' })).paused).toBe(true);
});
