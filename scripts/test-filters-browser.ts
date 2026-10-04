import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { AudioOperation, BrowserAudioSample, AudioRequest, AudioReply } from '../src/shared/audio-engine';
import type { ControllerEvent, PlaybackAction, SyncStatus } from '../src/shared/domain';
type Controller = { update(event: ControllerEvent, now: number): PlaybackAction[]; snapshot(): SyncStatus };
import type { ProbeSnapshot, UserCommand } from '../src/shared/protocol';
declare global {
  var filterTestBrowser: Browser;
  var filterTestPage: Page;
  var filterTestErrors: string[];
  var testState: ProbeSnapshot & Required<Pick<ProbeSnapshot, 'library'>>;
  var filterCalls: { command: UserCommand; resolve: () => void }[];
  var filterListener: (state: ProbeSnapshot) => void;
}
const folder = await mkdtemp(join(tmpdir(), 'comms-filter-browser-'));
let browser: Browser | undefined, host: { handle(message: AudioRequest): Promise<AudioReply>; close(): void } | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.COMMS_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  globalThis.filterTestBrowser = browser;
  await build({ entryPoints: ['src/main/audio-host.ts'], outfile: join(folder, 'host.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'browser-adapter', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'adapter' }));
    build.onLoad({ filter: /.*/, namespace: 'adapter' }, () => ({ contents: `
export class BrowserWindow {
  constructor() { this.pagePromise = globalThis.filterTestBrowser.newPage();
    this.webContents = { setAudioMuted() {}, setWindowOpenHandler() {}, on() {},
      executeJavaScript: async code => (await this.pagePromise).evaluate(code) };
  }
  async loadURL(url) { const page = await this.pagePromise; globalThis.filterTestPage = page; page.on('pageerror', error => globalThis.filterTestErrors.push(error.message)); await page.goto(url);
    await page.evaluate(() => {
      globalThis.filterTestChunks = new Map();
      const NativeNode = globalThis.AudioWorkletNode;
      globalThis.AudioWorkletNode = class extends NativeNode {
        constructor(...args) {
          super(...args);
          const send = this.port.postMessage.bind(this.port);
          this.port.postMessage = (data, transfer) => {
            const chunks = globalThis.filterTestChunks;
            if (data.type === 'reset') chunks.clear();
            if (data.type === 'reset-clean') for (const chunk of chunks.values()) chunk.clean = undefined;
            if (data.type === 'chunk') {
              let chunk = chunks.get(data.start);
              if (!chunk) { chunk = { start: data.start, raw: [new Float32Array(48000), new Float32Array(48000)] }; chunks.set(data.start, chunk); }
              for (let channel = 0; channel < 2; channel++) chunk.raw[channel].set(data.raw[channel], data.offset ?? 0);
              chunk.length = data.length;
            }
            if (data.type === 'clean-chunk') {
              const chunk = chunks.get(data.start);
              if (chunk) {
                const clean = chunk.clean?.buffer.byteLength === 48000 * 4 ? new Float32Array(chunk.clean.buffer) : new Float32Array(48000);
                clean.set(data.clean, data.offset ?? 0); chunk.clean = clean.subarray(0, data.length);
              }
            }
            if (data.type === 'evict') for (const start of chunks.keys()) if (start < data.before || start > data.after) chunks.delete(start);
            return send(data, transfer);
          };
        }
      };
    });
  }
  destroy() { void this.pagePromise.then(page => page.close()); }
}` }));
  } }] });
  globalThis.filterTestErrors = [];
  const { AudioHost } = await import(pathToFileURL(join(folder, 'host.mjs')).href);
  const ffmpeg = process.env.COMMS_FFMPEG ?? resolve('resources/bin/linux-x64/ffmpeg');
  host = new AudioHost(resolve('dist/audio'), ffmpeg);
  let id = 0;
  async function run(operation: AudioOperation): Promise<BrowserAudioSample> {
    const result = await host!.handle({ type: 'audio-request', id: ++id, operation });
    assert.equal(result.error, undefined, `${operation.type}: ${result.error}`); return result.data as BrowserAudioSample;
  }
  // Generated two-track WAV-compatible media tests native track selection.
  const { execFileSync } = await import('node:child_process');
  const fixture = join(folder, 'tracks.mkv');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=18', '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_f32le', fixture]);
  await run({ type: 'load', path: fixture, audioIndex: 0, channels: 1, origin: 0, duration: 18 });
  const page = globalThis.filterTestPage;
  const original = await page.evaluate<{ peak: number; identical: boolean; protectionDelay: number }>(`(() => { const chunk = globalThis.filterTestChunks.get(0); return { peak: Math.max(...chunk.raw[0]), identical: chunk.raw[0].every((value, index) => value === chunk.raw[1][index]), protectionDelay: globalThis.audioEngine.protectionDelay }; })()`);
  assert.ok(original.peak > 0.124 && original.peak < 0.126, 'Mono decoding must not add a −3 dB downmix gain');
  assert.equal(original.identical, true);
  assert.ok(original.protectionDelay >= 0 && original.protectionDelay < 0.02);
  // Compare the strict 1× filter graph against the verified prototype circuit.
  const graph = await build({ entryPoints: ['src/audio/graph.ts'], bundle: true, write: false, format: 'iife', globalName: 'graphParity' });
  await page.evaluate(graph.outputFiles[0]!.text + ';globalThis.graphParity = graphParity;');
  const graphError = await page.evaluate<number>(`(async () => {
    const length = 48000, settings = { radio: { enabled: true, strength: 100 }, noise: { enabled: true, attenuation: 25 }, position: { enabled: false, pan: -60 } };
    async function render(production) {
      const context = new OfflineAudioContext(2, length, 48000);
      const clean = context.createBufferSource(), raw = context.createBufferSource();
      clean.buffer = context.createBuffer(2, length, 48000); raw.buffer = context.createBuffer(2, length, 48000);
      for (let channel = 0; channel < 2; channel++) for (let i = 9600; i < length; i++) {
        clean.buffer.getChannelData(channel)[i] = .05 * Math.sin(2 * Math.PI * 120 * i / 48000) + .03 * Math.sin(2 * Math.PI * 1800 * i / 48000);
        raw.buffer.getChannelData(channel)[i] = .1 * Math.sin(2 * Math.PI * 700 * i / 48000);
      }
      if (production) {
        const reader = { connect(destination, output) { (output === 1 ? clean : raw).connect(destination); return destination; } };
        const filter = new globalThis.graphParity.FilterGraph(context, reader); filter.apply(settings); filter.setVolume(100);
      } else {
        // Prototype: cleaned source → two Butterworth HP/LP pairs → presence
        // → fixed +12 dB → centered panner → volume → protection compressor.
        let last = clean;
        for (let pair = 0; pair < 2; pair++) {
          const high = context.createBiquadFilter(), low = context.createBiquadFilter();
          high.type = 'highpass'; high.frequency.value = 550; high.Q.value = Math.SQRT1_2;
          low.type = 'lowpass'; low.frequency.value = 2600; low.Q.value = Math.SQRT1_2;
          last.connect(high).connect(low); last = low;
        }
        const presence = context.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 1800; presence.Q.value = .9; presence.gain.value = 8;
        const gain = context.createGain(); gain.gain.value = 10 ** (12 / 20);
        const panner = context.createStereoPanner(), volume = context.createGain(), protection = context.createDynamicsCompressor();
        protection.threshold.value = -2; protection.knee.value = 0; protection.ratio.value = 20; protection.attack.value = .003; protection.release.value = .1;
        last.connect(presence).connect(gain).connect(panner).connect(volume).connect(protection).connect(context.destination);
      }
      raw.start(); clean.start(); return (await context.startRendering()).getChannelData(0);
    }
    const actual = await render(true), expected = await render(false);
    let error = 0; for (let i = 9600; i < length; i++) error = Math.max(error, Math.abs(actual[i] - expected[i]));
    return error;
  })()`);
  assert.ok(graphError < 1e-6, 'Radio + noise graph must match the prototype without a second audible path: ' + graphError);
  if (process.env.COMMS_FILTER_PROTOTYPE) {
    const prototype = process.env.COMMS_FILTER_PROTOTYPE;
    const voiced = join(folder, 'prototype-parity.wav');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.04*sin(2*PI*120*t)+0.025*sin(2*PI*240*t)+0.01*sin(2*PI*1800*t):s=48000:d=6', '-c:a', 'pcm_s16le', voiced]);
    await run({ type: 'filters', filters: { radio: { enabled: true, strength: 100 }, noise: { enabled: true, attenuation: 25 }, position: { enabled: false, pan: -60 } } });
    await run({ type: 'load', path: voiced, audioIndex: 0, channels: 1, origin: 0, duration: 6 });
    await page.waitForFunction(() => { const chunks = (globalThis as unknown as { filterTestChunks: Map<number, { clean?: Float32Array }> }).filterTestChunks; return [0, 48000].every(start => chunks.get(start)?.clean?.length === 48000); });
    await page.route('**/prototype-parity/*', async route => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
      await route.fulfill({ contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: await readFile(join(prototype, 'assets', name)) });
    });
    const bytes = Array.from(await readFile(voiced));
    const difference = await page.evaluate<number>(`(async () => {
      const file = new File([new Uint8Array(${JSON.stringify(bytes)})], 'voiced.wav');
      const worker = new Worker(new URL('./prototype-parity/ahead-worker.js', location.href), { type: 'module' });
      try {
        return await new Promise((resolve, reject) => {
          const chunks = new Map();
          worker.onerror = event => reject(new Error(event.message));
          worker.onmessage = ({ data }) => {
            if (data.type === 'error') reject(new Error(data.message));
            if (data.type === 'ready') worker.postMessage({ type: 'prepare', epoch: 1, start: 0, end: 3 * 48000, attenuationLimit: 25 });
            if (data.type !== 'chunk') return;
            chunks.set(data.start, data);
            if (!chunks.has(0) || !chunks.has(48000)) return;
            let difference = 0;
            for (const start of [0, 48000]) {
              const reference = chunks.get(start), actual = globalThis.filterTestChunks.get(start);
              for (let i = 0; i < 48000; i++) {
                difference = Math.max(difference, Math.abs(reference.raw[0][i] - actual.raw[0][i]), Math.abs(reference.clean[i] - actual.clean[i]));
              }
            }
            resolve(difference);
          };
          worker.postMessage({ type: 'init', file });
        });
      } finally { worker.terminate(); }
    })()`);
    assert.ok(difference < 1e-6, 'Native decoding and model output must match the actual prototype worker: ' + difference);
    console.log('Verified prototype worker sample parity and strict 1× combined-filter graph; max differences:', difference, graphError);
    await run({ type: 'load', path: fixture, audioIndex: 0, channels: 1, origin: 0, duration: 18 });
  }
  for (let bits = 0; bits < 8; bits++) {
    await run({ type: 'filters', filters: { radio: { enabled: Boolean(bits & 1), strength: 100 }, noise: { enabled: Boolean(bits & 2), attenuation: 25 }, position: { enabled: Boolean(bits & 4), pan: -60 } } });
    await run({ type: 'pause', paused: false });
    await page.waitForTimeout(120);
    const sample = await run({ type: 'observe' });
    assert.equal(sample.paused, false); assert.equal(sample.seeking, false);
    await run({ type: 'pause', paused: true });
  }
  await run({ type: 'pause', paused: false });
  await page.evaluate(`(() => {
    const engine = globalThis.audioEngine;
    engine.cleanWorker.onerror({ message: 'Injected speech-model failure' });
    engine.fallbackTap = engine.context.createAnalyser();
    engine.graph.volume.connect(engine.fallbackTap);
  })()`);
  await page.waitForTimeout(200);
  const fallback = await run({ type: 'observe' });
  assert.equal(fallback.paused, false);
  assert.ok(fallback.suppressionError?.includes('Injected speech-model failure'));
  const fallbackPeak = await page.evaluate<number>(`(() => {
    const engine = globalThis.audioEngine, samples = new Float32Array(engine.fallbackTap.fftSize);
    engine.fallbackTap.getFloatTimeDomainData(samples);
    engine.graph.volume.disconnect(engine.fallbackTap); delete engine.fallbackTap;
    return Math.max(...samples.map(Math.abs));
  })()`);
  assert.ok(Number.isFinite(fallbackPeak) && fallbackPeak > 1e-7, 'A suppression failure must retain rendered original audio');
  await run({ type: 'pause', paused: true });
  // Hold real worklet pause acknowledgements long enough to expose overlapping
  // controller pause+seek requests and noise slider rebuilds deterministically.
  await page.evaluate(`(() => {
    const engine = globalThis.audioEngine, port = engine.reader.port;
    engine.originalPauseHandler = port.onmessage;
    port.onmessage = event => event.data.type === 'paused'
      ? setTimeout(() => engine.originalPauseHandler(event), 120)
      : engine.originalPauseHandler(event);
  })()`);
  await run({ type: 'pause', paused: false });
  await Promise.all([run({ type: 'pause', paused: true }), run({ type: 'seek', seconds: 14 })]);
  assert.ok(Math.abs((await run({ type: 'observe' })).positionSeconds - 14) < 0.001);
  await run({ type: 'pause', paused: false });
  await Promise.all([run({ type: 'pause', paused: true }), run({ type: 'filters', filters: { radio: { enabled: true, strength: 100 }, noise: { enabled: true, attenuation: 30 }, position: { enabled: false, pan: -60 } } })]);
  assert.equal((await run({ type: 'observe' })).paused, true);
  await page.evaluate(`(() => { const engine = globalThis.audioEngine; engine.reader.port.onmessage = engine.originalPauseHandler; delete engine.originalPauseHandler; })()`);
  await run({ type: 'seek', seconds: 14 });
  assert.ok(Math.abs((await run({ type: 'observe' })).positionSeconds - 14) < 0.001);
  await run({ type: 'filters', filters: { radio: { enabled: true, strength: 150 }, noise: { enabled: true, attenuation: 40 }, position: { enabled: true, pan: 100 } } });
  assert.ok(Math.abs((await run({ type: 'observe' })).positionSeconds - 14) < 0.001);
  await run({ type: 'rate', rate: 2 }); await run({ type: 'pause', paused: false });
  const first = await run({ type: 'observe' }); await page.waitForTimeout(500); const second = await run({ type: 'observe' });
  assert.ok(second.positionSeconds - first.positionSeconds > 0.8 && second.positionSeconds - first.positionSeconds < 1.2);
  await run({ type: 'pause', paused: true });
  await run({ type: 'load', path: fixture, audioIndex: 1, channels: 1, origin: 0, duration: 18 });
  await run({ type: 'seek', seconds: 17.95 });
  await run({ type: 'pause', paused: false }); await page.waitForTimeout(200);
  assert.equal((await run({ type: 'observe' })).paused, true);
  await run({ type: 'load', path: fixture, audioIndex: 0, channels: 1, origin: 0, duration: 18 });
  await build({ entryPoints: ['src/sync/controller.ts'], outfile: join(folder, 'controller.mjs'), bundle: true, platform: 'node', format: 'esm' });
  const { Synchronizer } = await import(pathToFileURL(join(folder, 'controller.mjs')).href);
  // Model a 200 ms output queue, as can occur with wireless/headset drivers.
  await page.evaluate(`globalThis.audioEngine.outputClock = function () { return this.context.currentTime - 0.2; }`);
  const controller: Controller = new Synchronizer({ freshnessSeconds: 0.3, maxRoundTripSeconds: 0.15, deadbandSeconds: 0.025, jumpSeconds: 0.12, resyncSeconds: 0.1, settleSeconds: 0.075, seekTimeoutSeconds: 30, maxRateCorrection: 0.02, minSpeed: 0.5, maxSpeed: 2 });
  let seeking: Promise<void> | undefined;
  const failures: string[] = [];
  const now = () => performance.now() / 1000;
  const dispatch = (event: ControllerEvent) => {
    const actions = controller.update(event, now());
    for (const action of actions) {
      if (action.type === 'seek') {
        seeking = run({ type: 'seek', seconds: action.targetSeconds }).then(async () => {
          // Reproduce slower preparation/IPC while the League clock advances.
          await page.waitForTimeout(200);
          const sample = await run({ type: 'observe' });
          dispatch({ type: 'seek-complete', generation: action.generation, sample: { ...sample, observedAtSeconds: now() } });
        }).catch(error => { failures.push(String(error)); dispatch({ type: 'seek-failed', generation: action.generation, message: String(error) }); }).finally(() => { seeking = undefined; });
      } else {
        void run(action.type === 'pause' ? { type: 'pause', paused: action.paused } : { type: 'rate', rate: action.rate }).catch(error => { failures.push(String(error)); });
      }
    }
  };
  const start = now();
  const replay = () => ({ sessionId: 'test', timeSeconds: 3 + now() - start, speed: 1, paused: false, seeking: false, lengthSeconds: 18, sentAtSeconds: now(), receivedAtSeconds: now() });
  dispatch({ type: 'replay', sample: replay() });
  dispatch({ type: 'bind', binding: { replaySessionId: 'test', offsetSeconds: 0, startSeconds: 0, endSeconds: 18 } });
  dispatch({ type: 'mode', mode: 'follow' });
  for (let i = 0; i < 200; i++) {
    dispatch({ type: 'replay', sample: replay() });
    if (!seeking) { const sample = await run({ type: 'observe' }); dispatch({ type: 'audio', sample: { ...sample, observedAtSeconds: now() } }); }
    dispatch({ type: 'tick' });
    await page.waitForTimeout(50);
  }
  await seeking;
  assert.deepEqual(failures, []);
  assert.equal(controller.snapshot().state, 'following', JSON.stringify(controller.snapshot()));
  assert.equal((await run({ type: 'observe' })).paused, false);
  await run({ type: 'pause', paused: true });
  await page.evaluate(`delete globalThis.audioEngine.outputClock`);
  const offsetFixture = join(folder, 'offset-tracks.mkv');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-copyts', '-itsoffset', '3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18', '-itsoffset', '5', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=16', '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_f32le', offsetFixture]);
  await run({ type: 'load', path: offsetFixture, audioIndex: 1, channels: 1, origin: 3, duration: 18 });
  await page.waitForFunction(() => { const cache = (globalThis as unknown as { filterTestChunks: Map<number, { length: number }> }).filterTestChunks; return [0, 48000].every(start => cache.get(start)?.length === 48000); });
  const gap = await page.evaluate<{ first: number; second: number }>(`(() => { const cache = globalThis.filterTestChunks; return { first: Math.max(...cache.get(0).raw[0].map(Math.abs)), second: Math.max(...cache.get(48000).raw[0].map(Math.abs)) }; })()`);
  assert.equal(gap.first, 0); assert.equal(gap.second, 0, 'Preserve the selected track’s delayed start');
  await run({ type: 'seek', seconds: 14 });
  const recovered = await page.evaluate<number>(`(() => { const chunk = globalThis.filterTestChunks.get(14 * 48000); return Math.max(...chunk.raw[0].map(Math.abs)); })()`);
  assert.ok(recovered > 0.124 && recovered < 0.126);
  const longFixture = join(folder, 'long-recording.flac');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1200', '-c:a', 'flac', longFixture]);
  await run({ type: 'load', path: longFixture, audioIndex: 0, channels: 1, origin: 0, duration: 1200 });
  for (const seconds of [900, 10, 600]) {
    await run({ type: 'seek', seconds });
    assert.ok(Math.abs((await run({ type: 'observe' })).positionSeconds - seconds) < 0.001);
    await run({ type: 'pause', paused: false }); await page.waitForTimeout(100);
    assert.equal((await run({ type: 'observe' })).paused, false);
    await run({ type: 'pause', paused: true });
  }
  // Keep playing beyond several initial read-ahead windows, including the
  // non-integral rates that the replay controller uses for small corrections.
  for (const noise of [false, true]) {
    await run({ type: 'filters', filters: { radio: { enabled: true, strength: 100 }, noise: { enabled: noise, attenuation: 25 }, position: { enabled: false, pan: -60 } } });
    await run({ type: 'seek', seconds: 100.123 });
    await page.evaluate(`(() => {
      const engine = globalThis.audioEngine, tap = engine.soundTap = engine.context.createScriptProcessor(512, 2, 2);
      engine.renderedPeak = 0;
      tap.onaudioprocess = event => { let peak = 0; for (const value of event.inputBuffer.getChannelData(0)) peak = Math.max(peak, Math.abs(value)); engine.renderedPeak = peak; };
      engine.graph.volume.connect(tap); tap.connect(engine.context.destination);
    })()`);
    await run({ type: 'rate', rate: 1.02 }); await run({ type: 'pause', paused: false });
    for (let observation = 0; observation < 32; observation++) {
      await page.waitForTimeout(250);
      const sample = await run({ type: 'observe' });
      assert.equal(sample.paused, false, `Continuous playback stopped (${noise ? 'suppression on' : 'suppression off'}): ${JSON.stringify(sample)}`);
      const peak = await page.evaluate<number>('globalThis.audioEngine.renderedPeak');
      assert.ok(peak > 1e-7 && Number.isFinite(peak), `Rendered audio went silent at observation ${observation}, suppression ${noise}: peak ${peak}`);
      if (observation === 7 || observation === 23) await run({ type: 'rate', rate: 1 });
      if (observation === 15) await run({ type: 'rate', rate: .98 });
    }
    await run({ type: 'pause', paused: true });
    await page.evaluate(`(() => { const engine = globalThis.audioEngine; engine.graph.volume.disconnect(engine.soundTap); engine.soundTap.disconnect(); delete engine.soundTap; })()`);
  }
  await run({ type: 'rate', rate: 1 });
  // Model initialization and obsolete suppression jobs must not interrupt rapid
  // navigation. The final destination eventually enhances without another seek.
  await run({ type: 'filters', filters: { radio: { enabled: true, strength: 100 }, noise: { enabled: true, attenuation: 25 }, position: { enabled: false, pan: -60 } } });
  for (const seconds of [300.11, 900.07, 50.333]) {
    await run({ type: 'seek', seconds }); await run({ type: 'pause', paused: false });
    await page.waitForTimeout(80);
    assert.equal((await run({ type: 'observe' })).paused, false);
  }
  await page.waitForFunction(() => (globalThis as unknown as { audioEngine: { suppressionActive: boolean } }).audioEngine.suppressionActive, undefined, { timeout: 10000 });
  const enhanced = await run({ type: 'observe' });
  assert.equal(enhanced.paused, false); assert.equal(enhanced.preparation?.suppressed, true);
  await run({ type: 'pause', paused: true });
  // Exercise the actual React controls, including shared optimistic edits.
  await build({ entryPoints: ['src/renderer/main.tsx'], outfile: join(folder, 'ui.js'), bundle: true, define: { 'process.env.NODE_ENV': '"production"' } });
  const ui = await browser.newPage({ viewport: { width: 560, height: 820 } });
  await ui.setContent('<div id="root"></div>');
  await ui.evaluate(() => {
    const filters = { radio: { enabled: true, strength: 100 }, noise: { enabled: true, attenuation: 25 }, position: { enabled: false, pan: -60 } };
    globalThis.testState = { workflow: { state: 'listening',  revision: 0, editorKey: 1, canReturn: false }, sync: { state: 'following', reason: 'Fixture', generation: 1 }, paused: false, busy: false,
      replay: { sessionId: 'fixture', seeking: false, lengthSeconds: 3000, sentAtSeconds: 0, receivedAtSeconds: 0, timeSeconds: 125, speed: 1, paused: false }, library: { recordings: [], mediaGeneration: 1, recordingReady: true, trackChosen: true, volume: 100, filters, folders: [], warnings: [], missingRecording: false } };
    globalThis.filterCalls = [];
    window.review = { openDropped: async () => {}, snapshot: async () => structuredClone(globalThis.testState), subscribe: callback => { globalThis.filterListener = callback; return () => {}; },
      command: command => new Promise(resolve => globalThis.filterCalls.push({ command, resolve })) };
  });
  await ui.addStyleTag({ path: 'src/renderer/style.css' }); await ui.addScriptTag({ path: join(folder, 'ui.js') });
  const radio = ui.getByRole('slider', { name: 'Radio voice strength' }).first();
  await radio.waitFor(); assert.equal(await radio.inputValue(), '100');

  assert.equal(await radio.getAttribute('min'), '50'); assert.equal(await radio.getAttribute('max'), '150');
  assert.ok(!(await ui.locator('.task .sound-filter').first().textContent())!.includes('%'));
  assert.ok(!(await ui.locator('.task .sound-filter').nth(1).textContent())!.includes('dB')); 
  assert.equal(await ui.getByRole('slider', { name: 'Noise suppression amount' }).first().inputValue(), '25');
  assert.equal(await ui.getByRole('slider', { name: 'Sound position' }).first().inputValue(), '-60');
  assert.equal(await ui.getByRole('slider', { name: 'Sound position' }).first().isDisabled(), true);
  await radio.focus(); await ui.keyboard.press('ArrowRight'); await ui.keyboard.press('ArrowRight');
  await ui.evaluate(() => { globalThis.filterListener(structuredClone(globalThis.testState)); });
  assert.equal(await radio.inputValue(), '102');
  await ui.evaluate(() => { const call = globalThis.filterCalls[0]!; if (call.command.type !== 'filters') throw new Error('Expected filter edit'); globalThis.testState.library.filters = call.command.filters; globalThis.filterListener(structuredClone(globalThis.testState)); call.resolve(); });
  assert.equal(await radio.inputValue(), '102');
  assert.equal(await radio.getAttribute('aria-valuetext'), 'Strength 53 of 101');
  await ui.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await ui.getByRole('dialog').getByRole('slider', { name: 'Radio voice strength' }).inputValue(), '102');
  await ui.evaluate(() => { globalThis.testState.library.filterError = 'Filter setting could not be applied.'; globalThis.filterListener(structuredClone(globalThis.testState)); });
  assert.equal(await ui.getByRole('dialog').getByRole('alert').textContent(), 'Filter setting could not be applied.');
  await ui.screenshot({ path: process.env.COMMS_FILTER_SCREENSHOT ?? join(folder, 'filters-ui.png') });
  await ui.getByRole('button', { name: 'Close settings', exact: true }).click();
  await ui.evaluate(() => {
    globalThis.testState.sync = { state: 'error', reason: 'Audio preparation was interrupted.', generation: 2 };
    globalThis.testState.workflow!.state = 'audio.error';
    globalThis.testState.workflow!.primary = 'Retry audio';
    globalThis.filterListener(structuredClone(globalThis.testState));
  });
  await ui.locator('.task[data-state="audio.error"]').waitFor();
  assert.equal(await ui.getByRole('alert').textContent(), 'Audio preparation was interrupted.');
  await ui.close();
  assert.deepEqual(globalThis.filterTestErrors, []);
  console.log('Passed real DeepFilterNet3, all filter combinations, large forward/backward jumps, seek/rebuild timing, 2× playback, track replacement and EOF.');
} finally { host?.close(); await browser?.close(); await rm(folder, { recursive: true, force: true }); }
