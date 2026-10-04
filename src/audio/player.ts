import { FilterGraph, measureProtectionDelay } from './graph';
import { defaultFilters } from '../shared/filters';
import { audioPreparationTimeoutMs } from '../shared/playback-timeouts';
import type { AudioOperation, BrowserAudioSample } from '../shared/audio-engine';
const RATE = 48000, AHEAD = 3 * RATE;
interface BufferedChunk { start: number; from: number; length: number }

class AudioPlayer {
  private context?: AudioContext;
  private reader?: AudioWorkletNode;
  private graph?: FilterGraph;
  private initialization?: Promise<void>;
  private worker?: Worker;
  private cleanWorker?: Worker;
  private cleanReady = false;
  private cleanEpoch = 0;
  private cleanStart = 0;
  private source?: string;
  private preparedAt = 0;
  private suppressionActive = false;
  private suppressionError?: string;
  private bufferedChunks = new Map<number, BufferedChunk>();
  private filters = defaultFilters();
  private volume = 100;
  private total = 0;
  private cursor = 0;
  private epoch = 0;
  private revision = 0;
  private playing = false;
  private seeking = false;
  private rate = 1;
  private anchorFrame = 0;
  private anchorTime = 0;
  private protectionDelay = 0;
  private failure?: string;
  private timings: Record<string, number> = {};
  private waits = new Set<() => void>();
  private pauseReply?: () => void;
  private pausing?: Promise<void>;
  private interruption?: Promise<void>;
  private timer = setInterval(() => this.maintain(), 250);
  private async initialize() {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      const context = this.context = new AudioContext({ sampleRate: RATE });
      if (context.sampleRate !== RATE) throw new Error('48 kHz audio output is unavailable.');
      const protectionDelay = await measureProtectionDelay();
      if (this.context !== context) throw new Error('Audio preparation was interrupted.');
      this.protectionDelay = protectionDelay;
      await context.audioWorklet.addModule('./timeline-worklet.js');
      if (this.context !== context) throw new Error('Audio preparation was interrupted.');
      const reader = this.reader = new AudioWorkletNode(context, 'recording-timeline', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2] });
      this.graph = new FilterGraph(context, reader); this.graph.apply(this.filters); this.graph.setVolume(this.volume);
      reader.port.onmessage = ({ data }) => {
        if (data.epoch !== this.epoch) return;
        if (data.type === 'enhancement') {
          this.suppressionActive = data.active;
          if (data.active && this.timings.suppressionStartedMs === undefined) this.timings.suppressionStartedMs = performance.now() - this.preparedAt;
        }
        if (data.type === 'paused') { this.cursor = data.frame; this.pauseReply?.(); this.pauseReply = undefined; }
        if (data.type === 'buffering' || data.type === 'ended') {
          this.playing = false; this.cursor = data.frame;
          // Let the existing replay synchronizer decide whether to resume/seek.
          this.notify();
        }
      };
      reader.addEventListener('processorerror', () => this.fail('Audio processing stopped. Retry audio.'));
      context.addEventListener('statechange', () => {
        if (context.state !== 'running' && this.playing) this.fail('Audio output was interrupted. Retry audio.');
      });
    })();
    return this.initialization;
  }
  private fail(message: string) {
    this.failure = message; this.playing = false; this.reader?.port.postMessage({ type: 'pause', epoch: this.epoch }); this.notify();
  }
  private notify() { for (const resolve of this.waits) resolve(); this.waits.clear(); }
  private outputClock() {
    const context = this.context!;
    const stamp = context.getOutputTimestamp();
    return stamp.performanceTime ? (stamp.contextTime ?? 0) + Math.max(0, performance.now() - stamp.performanceTime) / 1000 : context.currentTime - (context.outputLatency || context.baseLatency);
  }
  private startDelay() {
    if (!this.context) return 0;
    return Math.max(0, this.context.currentTime - this.outputClock()) + 0.02 + this.protectionDelay;
  }
  private position() {
    if (!this.playing || !this.context) return this.cursor;
    const clock = this.outputClock();
    return Math.max(0, Math.min(this.total, this.anchorFrame + (clock - this.anchorTime - this.protectionDelay) * RATE * this.rate));
  }
  private buffered(frame = this.cursor) {
    let end = frame;
    while (end < this.total) {
      const item = this.bufferedChunks.get(Math.floor(end / RATE) * RATE);
      if (!item || end < item.from || item.start + item.length <= end) break;
      end = item.start + item.length;
    }
    return end - frame;
  }
  private prefilled() { return this.buffered() >= Math.min(Math.ceil((0.06 * this.rate + 0.02) * RATE), this.total - this.cursor); }
  private async waitFor(test: () => boolean, ticket: number) {
    const deadline = performance.now() + audioPreparationTimeoutMs;
    while (!test()) {
      if (ticket !== this.revision) throw new Error('Audio preparation was interrupted.');
      if (this.failure) throw new Error(this.failure);
      if (performance.now() > deadline) throw new Error('Audio preparation timed out. Retry audio.');
      await new Promise<void>(resolve => { this.waits.add(resolve); setTimeout(() => { this.waits.delete(resolve); resolve(); }, 100); });
    }
    if (ticket !== this.revision) throw new Error('Audio preparation was interrupted.');
    if (this.failure) throw new Error(this.failure);
  }
  private prepare(frame: number) {
    this.bufferedChunks.clear(); this.timings = {}; this.preparedAt = performance.now(); this.epoch++;
    this.reader!.port.postMessage({ type: 'reset', epoch: this.epoch, frame });
    this.reader!.port.postMessage({ type: 'reference', epoch: this.epoch, clean: this.filters.noise.enabled });
    this.restartClean(frame);
    this.worker!.postMessage({ type: 'prepare', epoch: this.epoch, start: Math.floor(frame / 480) * 480, end: frame + AHEAD, attenuationLimit: this.filters.noise.attenuation, noise: false });
  }
  // Suppression never gates the raw decoder or the playback deadline. Its
  // independently prepared samples are patched onto the same source timeline.
  private restartClean(frame: number) {
    this.suppressionActive = false; this.suppressionError = undefined;
    this.cleanStart = frame;
    this.cleanEpoch++;
    this.reader?.port.postMessage({ type: 'reset-clean', epoch: this.epoch });
    if (!this.filters.noise.enabled || !this.source || !this.worker) {
      this.cleanWorker?.terminate(); this.cleanWorker = undefined; this.cleanReady = false;
      return;
    }
    if (!this.cleanWorker) {
      const worker = this.cleanWorker = new Worker('./ahead-worker.js', { type: 'module' });
      worker.onerror = event => { if (worker === this.cleanWorker) this.suppressionFailed(event.message || 'Noise suppression failed.'); };
      worker.onmessage = ({ data }) => {
        if (worker !== this.cleanWorker) return;
        if (data.type === 'error' && (data.epoch === undefined || data.epoch === this.cleanEpoch)) { this.suppressionFailed(data.message); return; }
        if (data.type === 'ready') { this.cleanReady = true; this.prepareClean(); }
        if (data.epoch !== this.cleanEpoch) return;
        if (data.type === 'timing') this.timings = { ...this.timings, ...Object.fromEntries(Object.entries(data.values).map(([key, value]) => ['clean' + key[0]!.toUpperCase() + key.slice(1), value as number])) };
        if (data.type === 'chunk') {
          if (this.timings.cleanAvailableMs === undefined) this.timings.cleanAvailableMs = performance.now() - this.preparedAt;
          this.reader!.port.postMessage({ type: 'clean-chunk', epoch: this.epoch, start: data.start, offset: data.offset, from: data.from, length: data.length, clean: data.clean }, [data.clean.buffer]);
        }
      };
      worker.postMessage({ type: 'init', source: this.source, total: this.total, noise: true });
    } else if (this.cleanReady) this.prepareClean();
  }
  private suppressionFailed(message: string) {
    this.suppressionError = `Noise suppression is unavailable. Playing original audio. ${message}`;
    this.suppressionActive = false; this.cleanEpoch++;
    this.cleanWorker?.terminate(); this.cleanWorker = undefined; this.cleanReady = false;
    this.reader?.port.postMessage({ type: 'reset-clean', epoch: this.epoch });
  }
  private prepareClean() {
    this.cleanWorker!.postMessage({ type: 'prepare', epoch: this.cleanEpoch, start: Math.floor(this.cleanStart / 480) * 480,
      end: this.cleanStart + AHEAD, attenuationLimit: this.filters.noise.attenuation, noise: true });
  }
  private maintain() {
    if (!this.worker || !this.reader) return;
    const frame = this.position();
    this.worker.postMessage({ type: 'window', end: Math.round(frame + AHEAD) });
    this.cleanWorker?.postMessage({ type: 'window', end: Math.round(frame + AHEAD) });
    const before = Math.max(0, Math.floor(frame / RATE - 1) * RATE), after = Math.ceil(frame / RATE + 4) * RATE;
    for (const start of this.bufferedChunks.keys()) if (start < before || start > after) this.bufferedChunks.delete(start);
    this.reader.port.postMessage({ type: 'evict', epoch: this.epoch, before, after });
  }
  private pause(): Promise<void> {
    // Controller pause+seek actions and filter preparation can overlap. Every
    // caller must await the same acknowledgement before resetting the epoch.
    if (this.pausing) return this.pausing;
    ++this.revision; this.notify();
    if (!this.playing && !this.seeking) return Promise.resolve();
    this.cursor = Math.round(this.position()); this.playing = false;
    if (this.context?.state !== 'running') return Promise.resolve();
    const pending = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pauseReply = undefined; reject(new Error('Audio did not pause.')); }, 1000);
      this.pauseReply = () => { clearTimeout(timer); resolve(); };
      this.reader!.port.postMessage({ type: 'pause', epoch: this.epoch });
    });
    const settled = pending.finally(() => { if (this.pausing === settled) this.pausing = undefined; });
    this.pausing = settled;
    return settled;
  }
  private async play() {
    if (this.playing) return;
    if (!this.worker) throw new Error('Open a recording first.');
    const ticket = ++this.revision;
    if (this.cursor >= this.total) { this.cursor = 0; this.prepare(0); }
    this.maintain();
    await this.waitFor(() => this.prefilled(), ticket);
    await this.context!.resume();
    if (ticket !== this.revision) return;
    this.anchorFrame = this.cursor; this.anchorTime = this.context!.currentTime + 0.02;
    this.reader!.port.postMessage({ type: 'play', epoch: this.epoch, frame: this.cursor, when: this.anchorTime, end: this.total, rate: this.rate });
    this.playing = true;
  }
  async run(operation: AudioOperation & { source?: string }): Promise<unknown> {
    if (operation.type === 'volume') { this.volume = operation.volume; this.graph?.setVolume(this.volume); return; }
    if (operation.type === 'filters') {
      const changed = operation.filters.noise.enabled !== this.filters.noise.enabled || (operation.filters.noise.enabled && operation.filters.noise.attenuation !== this.filters.noise.attenuation);
      this.filters = structuredClone(operation.filters); this.graph?.apply(this.filters);
      this.reader?.port.postMessage({ type: 'reference', epoch: this.epoch, clean: this.filters.noise.enabled });
      if (changed && this.worker) {
        this.timings = {}; this.preparedAt = performance.now();
        this.restartClean(Math.round(this.position()));
      }
      return;
    }
    if (operation.type === 'interrupt' || operation.type === 'close') {
      if (!this.interruption) {
        const work = (async () => {
          // A broken worklet may never acknowledge pause. Closing the context
          // and terminating workers must still complete physical cleanup.
          await this.pause().catch(() => undefined);
          this.worker?.terminate(); this.worker = undefined;
          this.cleanWorker?.terminate(); this.cleanWorker = undefined; this.cleanReady = false; this.cleanEpoch++; this.source = undefined;
          this.epoch++; this.reader?.port.postMessage({ type: 'reset', epoch: this.epoch, frame: 0 }); this.bufferedChunks.clear(); this.failure = undefined; this.suppressionError = undefined;
          const context = this.context;
          this.context = undefined; this.reader = undefined; this.graph = undefined; this.initialization = undefined;
          if (context && context.state !== 'closed') await context.close();
        })();
        const settled = work.finally(() => { if (this.interruption === settled) this.interruption = undefined; });
        this.interruption = settled;
      }
      try { await this.interruption; }
      finally { if (operation.type === 'close') clearInterval(this.timer); }
      return;
    }
    if (operation.type === 'load') {
      await this.run({ type: 'interrupt' });
      const ticket = ++this.revision;
      await this.initialize();
      if (ticket !== this.revision) throw new Error('Audio preparation was interrupted.');
      this.source = operation.source;
      this.total = Math.ceil(operation.duration * RATE); this.cursor = 0; this.rate = 1;
      const worker = this.worker = new Worker('./ahead-worker.js', { type: 'module' });
      let ready = false;
      worker.onerror = event => { if (worker === this.worker) this.fail(event.message || 'Audio preparation failed.'); };
      worker.onmessage = ({ data }) => {
        if (worker !== this.worker) return;
        if (data.type === 'error' && (data.epoch === undefined || data.epoch === this.epoch)) { this.suppressionFailed(data.message); return; }
        if (data.type === 'ready') { ready = true; this.prepare(0); this.notify(); }
        if (data.type === 'timing' && data.epoch === this.epoch) this.timings = { ...this.timings, ...data.values };
        if (data.type === 'complete' && data.epoch === this.epoch) {
          this.total = Math.min(this.total, data.end);
          this.reader!.port.postMessage({ type: 'end', epoch: this.epoch, end: this.total });
          this.notify();
        }
        if (data.type === 'chunk' && data.epoch === this.epoch) {
          this.bufferedChunks.set(data.start, { start: data.start, from: data.from, length: data.length });
          this.reader!.port.postMessage(data, data.raw.map((channel: Float32Array) => channel.buffer));
          this.notify();
        }
      };
      worker.postMessage({ type: 'init', source: operation.source, total: this.total, noise: false });
      await this.waitFor(() => ready && this.prefilled(), ticket);
      return;
    }
    if (operation.type === 'seek') {
      await this.pause(); this.seeking = true;
      try {
        this.cursor = Math.round(Math.max(0, Math.min(this.total / RATE, operation.seconds)) * RATE);
        this.prepare(this.cursor);
        await this.waitFor(() => this.prefilled(), this.revision);
      } finally { this.seeking = false; }
      return;
    }
    if (operation.type === 'pause') { if (operation.paused) await this.pause(); else await this.play(); return; }
    if (operation.type === 'rate') {
      if (!Number.isFinite(operation.rate) || operation.rate < 0.48 || operation.rate > 2.04) throw new Error('Unsupported replay speed.');
      if (operation.rate === this.rate) return;
      const position = this.position();
      const clock = this.outputClock();
      this.anchorFrame = position; this.anchorTime = clock - this.protectionDelay;
      this.rate = operation.rate;
      this.reader!.port.postMessage({ type: 'rate', epoch: this.epoch, rate: this.rate });
      return;
    }
    if (this.failure) throw new Error(this.failure);
    return { suppressionError: this.suppressionError, positionSeconds: this.position() / RATE, paused: !this.playing, seeking: this.seeking, rate: this.rate, uncertaintySeconds: 128 / RATE, startDelaySeconds: this.startDelay(), preparation: { suppressed: this.suppressionActive, timingsMs: { ...this.timings } } } satisfies BrowserAudioSample;
  }
}
(globalThis as unknown as { audioEngine: AudioPlayer }).audioEngine = new AudioPlayer();
