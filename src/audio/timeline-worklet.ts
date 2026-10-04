export {};
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
interface Chunk { start: number; length: number; raw: Float32Array[] }
interface CleanChunk { start: number; from: number; length: number; clean: Float32Array }
class TimelinePlayer extends AudioWorkletProcessor {
  chunks = new Map<number, Chunk>();
  cleanChunks = new Map<number, CleanChunk>();
  cleanWeight = 0;
  enhanced = false;
  epoch = 0;
  cursor = 0;
  playing = false;
  when = 0;
  end = Infinity;
  rate = 1;
  grainOffset = 480;
  grain = [new Float32Array(480), new Float32Array(480), new Float32Array(480)];
  tail = [new Float32Array(480), new Float32Array(480), new Float32Array(480)];
  hasTail = false;
  reference = 0;
  private matchWindow = new Float32Array(960);
  private sample(frame: number, channel: number): number | undefined {
    // Speed correction leaves a fractional source cursor when returning to 1×.
    // Typed-array reads require an integer even if the clean path is muted:
    // undefined * zero still produces NaN and can poison the filter graph.
    frame = Math.floor(frame);
    if (frame >= this.end) return 0;
    if (frame < 0) return 0;
    const start = Math.floor(frame / sampleRate) * sampleRate;
    const chunk = this.chunks.get(start);
    if (!chunk || frame - start >= chunk.length) return;
    if (channel !== 2) return chunk.raw[channel]![frame - start];
    const clean = this.cleanChunks.get(start);
    if (clean && frame >= clean.from && frame - start < clean.length) return clean.clean[frame - start];
    return (chunk.raw[0]![frame - start]! + chunk.raw[1]![frame - start]!) * 0.5;
  }
  private hasClean(frame: number) {
    const start = Math.floor(frame / sampleRate) * sampleRate, chunk = this.cleanChunks.get(start);
    return Boolean(chunk && frame >= chunk.from && frame < start + chunk.length);
  }
  private resetStretch() { this.grainOffset = 480; this.hasTail = false; }
  // Waveform similarity overlap-add preserves voice pitch at League's 0.5–2×
  // speeds. Match the audible speech path, so removed game noise cannot cause
  // copies of speech to overlap out of phase. Both paths retain one source offset.
  private makeGrain(): boolean {
    const nominal = Math.round(this.cursor);
    let best = nominal, error = Infinity;
    const reference = this.reference === 2 && this.cleanWeight === 0 ? 0 : this.reference;
    if (this.hasTail) {
      // Read the search window once. Checking every candidate sample preserves
      // high-frequency phase without repeated chunk lookups in the inner loop.
      for (let i = 0; i < this.matchWindow.length; i++) this.matchWindow[i] = this.sample(nominal - 240 + i, reference) ?? NaN;
      for (let shift = -240; shift <= 240; shift++) {
        const candidate = nominal + shift;
        if (candidate < 0) continue;
        let difference = 0;
        for (let i = 0; i < 480; i += 8) {
          // Adjacent samples distinguish phases that a regular eight-sample
          // stride aliases (including the four-sample period of a 12 kHz tone).
          const a = this.matchWindow[shift + 240 + i]! - this.tail[reference]![i]!;
          const b = this.matchWindow[shift + 241 + i]! - this.tail[reference]![i + 1]!;
          difference += a * a + b * b;
        }
        if (difference < error) { error = difference; best = candidate; }
      }
    }
    for (let channel = 0; channel < 3; channel++) {
      for (let i = 0; i < 480; i++) {
        const value = this.sample(best + i, channel);
        const tail = this.sample(best + 480 + i, channel);
        if (value === undefined || tail === undefined) return false;
        const weight = this.hasTail ? 0.5 - 0.5 * Math.cos(Math.PI * i / 480) : 1;
        this.grain[channel]![i] = this.hasTail ? this.tail[channel]![i]! * (1 - weight) + value * weight : value;
        this.tail[channel]![i] = tail;
      }
    }
    this.hasTail = true; this.grainOffset = 0;
    return true;
  }
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'reset') { this.epoch = data.epoch; this.chunks.clear(); this.cleanChunks.clear(); this.cleanWeight = 0; this.enhanced = false; this.cursor = data.frame; this.playing = false; this.resetStretch(); }
      if (data.epoch !== this.epoch) return;
      if (data.type === 'chunk') {
        let chunk = this.chunks.get(data.start);
        if (!chunk) { chunk = { start: data.start, length: 0, raw: [new Float32Array(sampleRate), new Float32Array(sampleRate)] }; this.chunks.set(data.start, chunk); }
        const offset = data.offset ?? 0;
        for (let channel = 0; channel < 2; channel++) chunk.raw[channel]!.set(data.raw[channel], offset);
        chunk.length = data.length;
      }
      if (data.type === 'clean-chunk') {
        let chunk = this.cleanChunks.get(data.start);
        if (!chunk) { chunk = { start: data.start, from: data.from, length: 0, clean: new Float32Array(sampleRate) }; this.cleanChunks.set(data.start, chunk); }
        chunk.clean.set(data.clean, data.offset ?? 0); chunk.length = data.length;
      }
      if (data.type === 'reset-clean') { this.cleanChunks.clear(); this.cleanWeight = 0; this.enhanced = false; this.resetStretch(); }
      if (data.type === 'evict') for (const chunks of [this.chunks, this.cleanChunks]) for (const start of chunks.keys()) if (start < data.before || start > data.after) chunks.delete(start);
      if (data.type === 'rate') this.rate = data.rate;
      if (data.type === 'reference') { const reference = data.clean ? 2 : 0; if (reference !== this.reference) { this.reference = reference; this.resetStretch(); } }
      if (data.type === 'play') { this.rate = data.rate ?? 1; this.resetStretch(); this.cursor = data.frame; this.when = Math.round(data.when * sampleRate); this.end = data.end; this.playing = true; }
      if (data.type === 'end') this.end = data.end;
      if (data.type === 'pause') {
        this.playing = false;
        this.port.postMessage({ type: 'paused', epoch: this.epoch, frame: this.cursor, contextTime: currentFrame / sampleRate });
      }
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const raw = outputs[0]!;
    const clean = outputs[1]!;
    for (let i = 0; i < raw[0]!.length; i++) {
      if (!this.playing || currentFrame + i < this.when) continue;
      if (this.cursor >= this.end) {
        this.playing = false;
        this.port.postMessage({ type: 'ended', epoch: this.epoch, frame: this.cursor, contextTime: (currentFrame + i) / sampleRate });
        break;
      }
      const ready = this.hasClean(Math.floor(this.cursor)) && (this.rate === 1 || this.hasClean(Math.min(this.end - 1, Math.floor(this.cursor) + 1200)));
      if (ready !== this.enhanced) {
        this.enhanced = ready;
        this.port.postMessage({ type: 'enhancement', epoch: this.epoch, active: ready, frame: this.cursor, contextTime: (currentFrame + i) / sampleRate });
      }
      if (ready && this.cleanWeight === 0) this.resetStretch();
      this.cleanWeight = ready ? Math.min(1, this.cleanWeight + 1 / 2400) : 0;
      if (this.rate !== 1) {
        if (this.grainOffset >= 480 && !this.makeGrain()) {
          this.playing = false;
          this.port.postMessage({ type: 'buffering', epoch: this.epoch, frame: Math.round(this.cursor), contextTime: (currentFrame + i) / sampleRate });
          break;
        }
        for (let channel = 0; channel < raw.length; channel++) raw[channel]![i] = this.grain[Math.min(channel, 1)]![this.grainOffset]!;
        for (let channel = 0; channel < clean.length; channel++) clean[channel]![i] = raw[Math.min(channel, 1)]![i]! * (1 - this.cleanWeight) + this.grain[2]![this.grainOffset]! * this.cleanWeight;
        this.grainOffset++; this.cursor += this.rate;
        continue;
      }
      this.resetStretch();
      const start = Math.floor(this.cursor / sampleRate) * sampleRate;
      const chunk = this.chunks.get(start);
      if (!chunk || this.cursor - start >= chunk.length) {
        this.playing = false;
        this.port.postMessage({ type: 'buffering', epoch: this.epoch, frame: this.cursor, contextTime: (currentFrame + i) / sampleRate });
        break; // Freeze the recording cursor. Never skip words to catch up.
      }
      const offset = Math.floor(this.cursor - start);
      for (let channel = 0; channel < raw.length; channel++) raw[channel]![i] = chunk.raw[Math.min(channel, 1)]![offset]!;
      for (let channel = 0; channel < clean.length; channel++) clean[channel]![i] = raw[Math.min(channel, 1)]![i]! * (1 - this.cleanWeight) + this.sample(this.cursor, 2)! * this.cleanWeight;
      this.cursor++;
    }
    return true;
  }
}
registerProcessor('recording-timeline', TimelinePlayer);
