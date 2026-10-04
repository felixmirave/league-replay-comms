import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import executablePath from './electron-executable.ts';
import { seconds, startReplaySimulator } from './replay-simulator.ts';
import { sampleRate, writeWav } from './audio-verification.ts';
import type { ProbeSnapshot } from '../src/shared/protocol';

const execute = promisify(execFile);
export async function command(file: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execute(file, args, { env, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
}
export async function stopProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null || child.signalCode !== null) return; await delay(20); }
  child.kill('SIGKILL');
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null || child.signalCode !== null) return; await delay(20); }
  throw new Error('Owned process did not exit: ' + child.pid);
}
export async function waitSnapshot(page: Page, predicate: (state: ProbeSnapshot) => boolean, timeout = 15000) {
  const deadline = seconds() + timeout / 1000;
  let state: ProbeSnapshot | undefined;
  while (seconds() < deadline) {
    state = await page.evaluate(() => window.review.snapshot());
    if (state.error || state.startup === 'failed') throw new Error('Application failure: ' + JSON.stringify(state));
    if (predicate(state)) return state;
    await delay(50);
  }
  throw new Error('Application state did not converge: ' + JSON.stringify(state));
}
export class AudioCapture {
  private readonly chunks: Buffer[] = [];
  private count = 0;
  origin?: number;
  private error?: Error;
  private readonly child: ChildProcess;
  private readonly completed: Promise<void>;
  readonly path: string;
  constructor(path: string, env: NodeJS.ProcessEnv, log: string) {
    this.path = path;
    const output = createWriteStream(path, { flags: 'wx' });
    this.completed = new Promise((resolve, reject) => { output.once('finish', resolve); output.once('error', reject); });
    this.child = spawn('parec', ['--raw', '--format=s16le', '--rate=48000', '--channels=1', '--device=comms_verification.monitor', '--latency-msec=20'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stderr!.pipe(createWriteStream(log));
    this.child.once('error', error => { this.error = error; output.end(); });
    this.child.stdout!.on('data', (data: Buffer) => {
      this.origin ??= seconds() - data.length / 2 / sampleRate;
      this.count += data.length;
      if (this.count > 128 * 1024 * 1024) { this.error = new Error('Capture exceeded 128 MiB; end this session and start a new one'); this.child.kill(); return; }
      this.chunks.push(Buffer.from(data));
    });
    this.child.stdout!.pipe(output);
    this.child.once('exit', code => { if (code && code !== 0 && !this.error) this.error = new Error('Audio capture exited: ' + code); });
  }
  async ready() {
    for (let i = 0; i < 200; i++) { this.check(); if (this.count > sampleRate * 2 * 0.2) return; await delay(20); }
    throw new Error('Audio monitor produced no samples');
  }
  private check() { if (this.error) throw this.error; }
  get end() { return (this.origin ?? seconds()) + this.count / 2 / sampleRate; }
  async until(at: number) {
    const deadline = seconds() + 10;
    while (this.end < at) { this.check(); if (seconds() > deadline) throw new Error('Audio monitor stopped producing samples'); await delay(20); }
  }
  slice(start: number, end: number) {
    this.check();
    if (this.origin === undefined || start < this.origin || end > this.end) throw new Error('Requested audio is outside captured range');
    const pcm = Buffer.concat(this.chunks);
    const a = Math.round((start - this.origin) * sampleRate) * 2, b = Math.round((end - this.origin) * sampleRate) * 2;
    return pcm.subarray(a, b);
  }
  async close() { await stopProcess(this.child); await this.completed; this.check(); }
}
export async function startDesktop(folder: string, handle?: Parameters<typeof startReplaySimulator>[0]['handle']) {
  if (process.platform !== 'linux') throw new Error('Development verification requires Linux');
  await mkdir(folder, { recursive: true });
  const runtime = await mkdtemp(join(tmpdir(), 'comms-dev-'));
  const owned: ChildProcess[] = [];
  const logs: Promise<void>[] = [];
  let app: ElectronApplication | undefined, capture: AudioCapture | undefined;
  let simulator: Awaited<ReturnType<typeof startReplaySimulator>> | undefined;
  let closePromise: Promise<void> | undefined;
  const interrupted = () => { void close().catch(error => console.error(error)); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const cleanup = async () => {
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    const errors: string[] = [];
    if (app) {
      try { await Promise.race([app.close(), delay(10000).then(() => { throw new Error('Electron shutdown timed out'); })]); }
      catch (error) { errors.push(String(error)); try { await stopProcess(app.process()); } catch (failure) { errors.push(String(failure)); } }
    }
    try { await capture?.close(); } catch (error) { errors.push(String(error)); }
    try { await simulator?.close(); } catch (error) { errors.push(String(error)); }
    for (const child of owned.reverse()) { try { await stopProcess(child); } catch (error) { errors.push(String(error)); } }
    await Promise.all(logs);
    await rm(runtime, { recursive: true, force: true });
    if (errors.length) throw new Error('Verification cleanup failed: ' + errors.join('; '));
  };
  const close = () => closePromise ??= cleanup();
  const launch = (file: string, args: string[], env: NodeJS.ProcessEnv, name: string) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = createWriteStream(join(folder, name + '.log'));
    logs.push(new Promise<void>((resolve, reject) => { output.on('finish', resolve); output.on('error', reject); }));
    child.stderr!.pipe(output);
    child.stdout!.on('data', data => output.write(data));
    child.on('error', error => output.write(String(error)));
    owned.push(child); return child;
  };
  try {
    const baseEnv = { ...process.env, XDG_RUNTIME_DIR: runtime, PULSE_RUNTIME_PATH: runtime, PULSE_STATE_PATH: join(runtime, 'state') };
    const xvfb = launch('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp', '-ac'], baseEnv, 'display');
    const display = await new Promise<string>((resolveDisplay, reject) => {
      let text = '';
      const timeout = setTimeout(() => reject(new Error('Xvfb startup timed out')), 10000);
      xvfb.once('error', error => { clearTimeout(timeout); reject(error); });
      xvfb.once('exit', code => { clearTimeout(timeout); reject(new Error('Xvfb exited: ' + code)); });
      xvfb.stdout!.on('data', chunk => { text += chunk; if (/^\d+\n/.test(text)) { clearTimeout(timeout); resolveDisplay(':' + text.trim()); } });
    });
    const socket = join(runtime, 'pulse.sock');
    const pulseConfig = join(runtime, 'pulse.pa');
    await writeFile(pulseConfig, `load-module module-native-protocol-unix socket=${socket} auth-anonymous=1\nload-module module-null-sink sink_name=comms_verification format=s16le rate=48000 channels=1 channel_map=mono\nset-default-sink comms_verification\nset-default-source comms_verification.monitor\n`);
    const pulseArgs = ['-n', '--daemonize=no', '--exit-idle-time=-1', '--use-pid-file=no', '--disable-shm=yes', '--high-priority=no', '--realtime=no', '--log-target=stderr', '--file=' + pulseConfig];
    if (process.env.COMMS_DEV_PULSE_MODULES) pulseArgs.push('--dl-search-path=' + process.env.COMMS_DEV_PULSE_MODULES);
    const pulse = launch('pulseaudio', pulseArgs, baseEnv, 'pulse');
    const env: NodeJS.ProcessEnv = { ...baseEnv, DISPLAY: display, PULSE_SERVER: 'unix:' + socket, PULSE_SINK: 'comms_verification', PULSE_LATENCY_MSEC: '40' };
    delete env.COMMS_TEST_NULL_AUDIO;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (pulse.exitCode !== null) throw new Error('Private audio server exited; inspect pulse.log');
      try { await command('pactl', ['info'], env); ready = true; break; } catch { await delay(50); }
    }
    if (!ready) throw new Error('Private audio server did not become ready');
    capture = new AudioCapture(join(folder, 'output.s16le'), env, join(folder, 'capture.log'));
    await capture.ready();
    const calibration: number[] = [];
    const pcm = Buffer.alloc(sampleRate * 2);
    for (let i = sampleRate / 4; i < sampleRate / 2; i++) pcm.writeInt16LE(Math.round(7000 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), i * 2);
    const calibrationPath = join(folder, 'calibration.wav'); await writeWav(calibrationPath, pcm);
    for (let run = 0; run < 3; run++) {
      const started = seconds();
      await command('paplay', ['--device=comms_verification', '--latency-msec=20', calibrationPath], env);
      await capture.until(started + 1.2);
      const data = capture.slice(started, started + 1.2);
      let first = -1;
      for (let i = 0; i < data.length / 2; i++) if (Math.abs(data.readInt16LE(i * 2)) > 1000) { first = i; break; }
      if (first < 0) throw new Error('Audio calibration signal was not captured');
      calibration.push(first / sampleRate - 0.25);
    }
    const latency = [...calibration].sort((a, b) => a - b)[1]!;
    const uncertainty = Math.max(...calibration.map(value => Math.abs(value - latency))) + 0.03;
    if (Math.abs(latency) > 0.25 || uncertainty > 0.1) throw new Error('Audio capture timing uncertainty is too high: ' + JSON.stringify({ calibration, latency, uncertainty }));
    await writeFile(join(folder, 'calibration.json'), JSON.stringify({ sampleRate, calibration, latencySeconds: latency, uncertaintySeconds: uncertainty,
      method: 'Three independent paplay signals with a known 250 ms onset; includes command startup and virtual output latency', resolutionSeconds: 1 / sampleRate }, null, 2));
    const certificate = join(runtime, 'replay.pem'), key = join(runtime, 'replay.key');
    await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '2', '-subj', '/CN=Development Replay API', '-addext', 'subjectAltName=IP:127.0.0.1']);
    simulator = await startReplaySimulator({ certificate, key, log: join(folder, 'replay.jsonl'), handle });
    const profile = join(folder, 'profile');
    const appEnv = { ...env, COMMS_TEST_USER_DATA: profile, COMMS_DEV_REPLAY_PORT: String(simulator.port), COMMS_DEV_REPLAY_CA: certificate };
    const rendererErrors: string[] = [];
    const launchApp = async () => {
      app = await electron.launch({ executablePath, args: ['.', ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])], env: appEnv, timeout: 20000 });
      const processLog = createWriteStream(join(folder, `electron-${Date.now()}.log`));
      app.process().stderr?.pipe(processLog);
      const page = await app.firstWindow(); page.setDefaultTimeout(15000);
      page.on('console', message => { if (!processLog.writableEnded) processLog.write(`Renderer ${message.type()}: ${message.text()}\n`); });
      page.on('crash', () => rendererErrors.push('Renderer crashed'));
      page.on('pageerror', error => rendererErrors.push(String(error)));
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      await waitSnapshot(page, state => state.startup === 'ready' && !!state.library && !!state.replay && !state.connectionError);
      return { app, page, rendererErrors };
    };
    const launched = await launchApp();
    return { ...launched, folder, env, simulator, capture, latency, uncertainty, close,
      restart: async () => { await app!.context().tracing.stop({ path: join(folder, 'before-restart.zip') }); await app!.close(); return launchApp(); },
      selectFile: async (path: string) => {
        await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog; }, resolve(path));
      },
    };
  } catch (error) { try { await close(); } catch (failure) { throw new AggregateError([error, failure], 'Startup and cleanup failed'); } throw error; }
}
