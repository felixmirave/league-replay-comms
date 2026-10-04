import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import type { AudioOperation, AudioReply, AudioRequest } from '../src/shared/audio-engine';
import { defaultFilters } from '../src/shared/filters.ts';

const folder = await mkdtemp(join(tmpdir(), 'comms-seek-benchmark-'));
let browser: Browser | undefined;
let host: { handle(request: AudioRequest): Promise<AudioReply>; close(): void } | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.COMMS_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  (globalThis as unknown as { seekBenchmarkPage: typeof page }).seekBenchmarkPage = page;
  await build({ entryPoints: ['src/main/audio-host.ts'], outfile: join(folder, 'host.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'browser-adapter', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'adapter' }));
    builder.onLoad({ filter: /.*/, namespace: 'adapter' }, () => ({ contents: `export class BrowserWindow {
      constructor() { this.webContents = { setAudioMuted() {}, setWindowOpenHandler() {}, on() {}, executeJavaScript: code => globalThis.seekBenchmarkPage.evaluate(code) }; }
      loadURL(url) { return globalThis.seekBenchmarkPage.goto(url); } destroy() {}
    }` }));
  } }] });
  const ffmpeg = process.env.COMMS_FFMPEG ?? resolve('resources/bin/linux-x64/ffmpeg');
  const { AudioHost } = await import(pathToFileURL(join(folder, 'host.mjs')).href);
  host = new AudioHost(resolve('dist/audio'), ffmpeg);
  let id = 0;
  async function run(operation: AudioOperation) {
    const reply = await host!.handle({ type: 'audio-request', id: ++id, operation });
    if (reply.error) throw new Error(reply.error);
  }
  const results: unknown[] = [];
  for (const format of (process.env.COMMS_SEEK_FORMAT ? [process.env.COMMS_SEEK_FORMAT] : ['flac', 'mkv'])) {
    const fixture = join(folder, `recording.${format}`);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.04*sin(2*PI*120*t)+0.025*sin(2*PI*240*t)+0.01*sin(2*PI*1800*t):s=48000:d=1200', '-c:a', format === 'flac' ? 'flac' : 'aac', fixture]);
    for (const enabled of [false, true]) {
      const filters = defaultFilters(); filters.noise.enabled = enabled;
      await run({ type: 'filters', filters });
      await run({ type: 'load', path: fixture, audioIndex: 0, channels: 1, origin: 0, duration: 1200 });
      for (const seconds of [900.13, 10.47, 600.79, 100.02, 1100.66]) {
        const measurement = await page.evaluate(async input => {
          const target = input.seconds;
          const engine = (globalThis as unknown as { audioEngine: { run(operation: AudioOperation): Promise<unknown>; context: AudioContext; graph: { volume: GainNode }; timings?: Record<string, number> } }).audioEngine;
          const began = performance.now();
          await engine.run({ type: 'seek', seconds: target });
          const preparedMs = performance.now() - began;
          const tap = engine.context.createScriptProcessor(256, 2, 2);
          engine.graph.volume.connect(tap); tap.connect(engine.context.destination);
          const firstSound = new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('No rendered sound after jump')), 5000);
            tap.onaudioprocess = event => {
              if (!event.inputBuffer.getChannelData(0).some(value => Math.abs(value) > 1e-5)) return;
              clearTimeout(timeout); resolve(performance.now() - began);
            };
          });
          await engine.run({ type: 'pause', paused: false });
          const playingMs = performance.now() - began;
          const firstSoundMs = await firstSound;
          engine.graph.volume.disconnect(tap); tap.disconnect();
          if (input.noise) {
            const deadline = performance.now() + 5000;
            while (engine.timings?.suppressionStartedMs === undefined) {
              if (performance.now() > deadline) throw new Error('Suppression did not catch the live cursor');
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          await new Promise(resolve => setTimeout(resolve, 150));
          await engine.run({ type: 'pause', paused: true });
          return { preparedMs, playingMs, firstSoundMs, phases: { ...engine.timings } };
        }, { seconds, noise: enabled });
        results.push({ format, noise: enabled, seconds, ...measurement });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
  }
  if (process.env.COMMS_SEEK_REPORT) await writeFile(process.env.COMMS_SEEK_REPORT, JSON.stringify({ environment: 'Linux Chromium; generated mono recording; render callback, not measured physical output', results }, null, 2) + '\n');
} finally { host?.close(); await browser?.close(); await rm(folder, { recursive: true, force: true }); }
