import { Worker } from 'node:worker_threads';

export interface ClockText { text: string; confidence: number }
export interface ClockReader { read(png: Uint8Array, signal?: AbortSignal): Promise<ClockText> }

/** One reusable offline reader. Cancellation kills active WASM work, not just its promise. */
export class OcrReader implements ClockReader {
  private worker?: Worker;
  private ready?: Promise<boolean>;
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private closed = false;
  private pending = 0;
  private stopping: Promise<unknown> = Promise.resolve();
  constructor(private readonly workerPath: string, private readonly resources: string, private readonly deadlineMs = 15000) {}

  read(png: Uint8Array, signal?: AbortSignal): Promise<ClockText> {
    if (png.byteLength > 8_000_000 || png.byteLength < 24) return Promise.reject(new Error('Invalid clock image size'));
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Clock reading cancelled'));
    if (this.pending >= 4) return Promise.reject(new Error('Clock reader queue is full'));
    this.pending++;
    const operation = this.queue.then(async () => {
      await this.stopping;
      if (this.closed || signal?.aborted) throw new Error('Clock reading cancelled');
      const abort = () => { void this.stop(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await this.start();
        if (this.closed || signal?.aborted) throw new Error('Clock reading cancelled');
        const worker = this.worker!;
        const id = ++this.sequence;
        const result = await this.exchange<ClockText>(worker, message => {
          if (message.id !== id) return;
          if (message.type === 'error') throw new Error(String(message.message));
          if (message.type !== 'result' || typeof message.text !== 'string' || typeof message.confidence !== 'number' || !Number.isFinite(message.confidence) || message.confidence < 0 || message.confidence > 100) throw new Error('Invalid clock reader response');
          return { text: message.text, confidence: message.confidence };
        }, () => worker.postMessage({ type: 'read', id, png }));
        if (this.closed || signal?.aborted) throw new Error('Clock reading cancelled');
        return result;
      } finally { signal?.removeEventListener('abort', abort); }
    }).finally(() => { this.pending--; });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async close(): Promise<void> { this.closed = true; await this.stop(); await this.queue; }
  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    const worker = this.worker = new Worker(this.workerPath, { workerData: { resources: this.resources } });
    worker.on('error', () => { if (this.worker === worker) void this.stop(); });
    worker.once('exit', () => { if (this.worker === worker) { this.worker = undefined; this.ready = undefined; } });
    this.ready = this.exchange<boolean>(worker, message => {
      if (message.type === 'error') throw new Error(String(message.message));
      if (message.type === 'ready') return true;
    }).catch(async error => { await this.stop(); throw error; });
    return this.ready;
  }
  private async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined; this.ready = undefined;
    if (worker) this.stopping = worker.terminate();
    await this.stopping;
  }
  private exchange<T>(worker: Worker, read: (message: Record<string, unknown>) => T | undefined, send?: () => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: T) => {
        clearTimeout(deadline); worker.removeListener('message', message); worker.removeListener('error', failed); worker.removeListener('exit', exited);
        if (error) reject(error); else resolve(value!);
      };
      const message = (data: unknown) => {
        try {
          if (!data || typeof data !== 'object') throw new Error('Invalid clock worker message');
          const result = read(data as Record<string, unknown>);
          if (result !== undefined) finish(undefined, result);
        } catch (error) { finish(error as Error); }
      };
      const failed = (error: Error) => finish(error);
      const exited = () => finish(new Error('Clock reader stopped'));
      const deadline = setTimeout(() => { finish(new Error('Clock reading timed out')); void this.stop(); }, this.deadlineMs);
      worker.on('message', message); worker.once('error', failed); worker.once('exit', exited);
      try { send?.(); } catch (error) { finish(error as Error); }
    });
  }
}
