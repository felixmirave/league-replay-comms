/** DeepFilterNet3 preparation from the app's native FFmpeg decoder.
 * Adapted from the verified prototype: 480-sample hops, 1440-sample delay,
 * one second of seek history, no postfilter, bounded incremental chunks.
 * The raw worker never initializes the speech model; clean preparation runs
 * independently and cannot delay the first original samples after a seek.
 */
export {};
interface Bindings {
  initSync(options: { module: WebAssembly.Module }): unknown;
  df_create_default(attenuation: number): number;
  df_get_frame_length(state: number): number;
  df_process_frame(state: number, samples: Float32Array): Float32Array;
  df_set_post_filter_beta(state: number, value: number): void;
  df_free(state: number): void;
}
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };
const RATE = 48000, HOP = 480, DELAY = 1440;
let binding: Bindings;
let source = '', total = 0, generation = 0, horizon = 0;
let wake: (() => void) | undefined;
let abort: AbortController | undefined;
let job: Promise<void> = Promise.resolve();

function verifyDelay() {
  const state = binding.df_create_default(0.1);
  try {
    let random = 19;
    const samples = Float32Array.from({ length: HOP * 24 }, () => {
      random = (Math.imul(1664525, random) + 1013904223) >>> 0;
      return (random / 4294967296 * 2 - 1) * 0.1;
    });
    const output = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += HOP) output.set(binding.df_process_frame(state, samples.subarray(i, i + HOP)), i);
    let best = Infinity, lag = -1;
    for (let offset = 0; offset < HOP * 5; offset++) {
      let error = 0;
      for (let i = 4000; i < 6000; i++) error += (output[i + offset]! - samples[i]!) ** 2;
      if (error < best) { best = error; lag = offset; }
    }
    if (lag !== DELAY || best / 2000 > 0.00001) throw new Error(`Speech model timing changed (${lag} samples).`);
  } finally { if (state !== undefined) binding.df_free(state); }
}
function warm(state: number) {
  let seed = 71;
  for (let f = 0; f < 56; f++) {
    const frame = new Float32Array(HOP);
    if (f < 24) for (let i = 0; i < HOP; i++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const t = (f * HOP + i) / RATE;
      frame[i] = 0.05 * Math.sin(2 * Math.PI * 120 * t) + 0.025 * Math.sin(2 * Math.PI * 240 * t) + 0.015 * (seed / 4294967296 * 2 - 1);
    }
    binding.df_process_frame(state, frame);
  }
}
async function render(start: number, token: number, attenuation: number, noise: boolean) {
  const began = performance.now();
  const state = noise ? binding.df_create_default(attenuation) : undefined;
  const stateMs = performance.now() - began;
  const cancel = new AbortController(); abort = cancel;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (state !== undefined) {
      if (binding.df_get_frame_length(state) !== HOP) throw new Error('Unexpected speech model frame length.');
      binding.df_set_post_filter_beta(state, 0); warm(state);
    }
    const warmMs = performance.now() - began - stateMs;
    const delay = noise ? DELAY : 0;
    const from = noise ? Math.max(0, start - RATE) : start;
    const response = await fetch(`${source}&start=${from}`, { signal: cancel.signal });
    if (!response.ok || !response.body) throw new Error('Could not decode this audio track.');
    const decoderMs = performance.now() - began - stateMs - warmMs;
    let firstChunk = true;
    reader = response.body.getReader();
    let cursor = from, filled = 0, nextChunk = Math.floor(start / RATE) * RATE, published = nextChunk, yielded = performance.now();
    const mono = new Float32Array(HOP);
    let endFrame = total;
    const chunks = new Map<number, { raw: Float32Array[]; clean?: Float32Array }>();
    const chunk = (frame: number) => {
      const index = Math.floor(frame / RATE) * RATE;
      let item = chunks.get(index);
      if (!item) { item = { raw: noise ? [] : [new Float32Array(RATE), new Float32Array(RATE)], clean: noise ? new Float32Array(RATE) : undefined }; chunks.set(index, item); }
      return item;
    };
    function push(left: number, right: number) {
      if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error('Decoder returned invalid audio.');
      if (!noise && cursor < endFrame && cursor >= start) {
        const item = chunk(cursor); item.raw[0]![cursor % RATE] = left; item.raw[1]![cursor % RATE] = right;
      }
      mono[filled++] = (left + right) * 0.5; cursor++;
      if (filled !== HOP) return;
      const out = state === undefined ? mono : binding.df_process_frame(state, mono);
      if (out.length !== HOP || !out.every(Number.isFinite)) throw new Error('Speech model returned invalid audio.');
      const outputStart = cursor - HOP - delay;
      for (let i = 0; noise && i < HOP; i++) {
        const frame = outputStart + i;
        if (frame >= start && frame < endFrame) chunk(frame).clean![frame % RATE] = out[i]!;
      }
      filled = 0;
      publish(Math.min(cursor - delay, endFrame));
    }
    function publish(ready: number) {
      while (nextChunk < endFrame) {
        const end = Math.min(nextChunk + RATE, ready);
        if (end <= Math.max(published, start)) break;
        if (end - published < 2400 && end !== nextChunk + RATE && end !== endFrame) break;
        const item = chunks.get(nextChunk)!;
        const length = end - nextChunk;
        const offset = Math.max(published, start) - nextChunk;
        const raw = item.raw.map(channel => channel.slice(offset, length)), clean = noise ? item.clean!.slice(offset, length) : undefined;
        if (firstChunk) { firstChunk = false; scope.postMessage({ type: 'timing', epoch: token, values: { stateMs, warmMs, decoderMs, firstChunkMs: performance.now() - began } }); }
        scope.postMessage({ type: 'chunk', epoch: token, start: nextChunk, offset, from: Math.max(start, nextChunk), length, raw, clean }, [...raw.map(channel => channel.buffer), ...(clean ? [clean.buffer] : [])]);
        published = end;
        if (end < Math.min(nextChunk + RATE, endFrame)) break;
        chunks.delete(nextChunk); nextChunk += RATE; published = nextChunk;
      }
    }

    let remainder = new Uint8Array(0);
    while (cursor < total && token === generation) {
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = new Uint8Array(remainder.length + value.length); bytes.set(remainder); bytes.set(value, remainder.length);
      const view = new DataView(bytes.buffer);
      const complete = bytes.length - bytes.length % 8;
      for (let i = 0; i < complete && cursor < total; i += 8) {
        push(view.getFloat32(i, true), view.getFloat32(i + 4, true));
        if (filled === 0) {
          while (token === generation && nextChunk >= horizon && nextChunk < total) await new Promise<void>(resolve => { wake = resolve; });
          if (performance.now() - yielded >= 8) {
            await new Promise<void>(resolve => setTimeout(resolve, 0)); yielded = performance.now();
          }
        }
        if (token !== generation) return;
      }
      remainder = bytes.slice(complete);
    }
    if (token !== generation) return;
    if (remainder.length) throw new Error('Decoder returned incomplete audio.');
    // EOF may precede the video end. Flush only the partial hop and model delay,
    // never synthesize the remainder of a longer recording.
    endFrame = Math.min(total, cursor);
    const flushEnd = Math.ceil((endFrame + delay) / HOP) * HOP;
    while (cursor < flushEnd) { push(0, 0); if (token !== generation) return; }
    publish(endFrame);
    scope.postMessage({ type: 'complete', epoch: token, end: endFrame });
  } finally { await reader?.cancel().catch(() => {}); if (state !== undefined) binding.df_free(state); }
}
scope.onmessage = ({ data }) => {
  if (data.type === 'window') { horizon = data.end; wake?.(); wake = undefined; return; }
  if (data.type === 'prepare') {
    generation = data.epoch; horizon = data.end; abort?.abort(); wake?.(); wake = undefined;
    const token = generation;
    job = job.catch(() => {}).then(() => token === generation ? render(data.start, token, data.attenuationLimit, data.noise !== false) : undefined).catch(error => {
      if (token === generation) scope.postMessage({ type: 'error', epoch: token, message: String(error) });
    });
    return;
  }
  if (data.type !== 'init') return;
  void (async () => {
    source = data.source; total = data.total;
    if (data.noise === false) { scope.postMessage({ type: 'ready', total, delay: 0 }); return; }
    const modelUrl = './deepfilter-module.js';
    binding = await import(/* @vite-ignore */ modelUrl) as Bindings;
    const response = await fetch(new URL('./deepfilter.wasm', import.meta.url));
    if (!response.ok) throw new Error('Could not load the local speech model.');
    binding.initSync({ module: await WebAssembly.compile(await response.arrayBuffer()) });
    verifyDelay();
    scope.postMessage({ type: 'ready', total, delay: DELAY });
  })().catch(error => scope.postMessage({ type: 'error', message: String(error) }));
};
