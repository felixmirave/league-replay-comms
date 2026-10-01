import { Worker } from 'node:worker_threads';
import { frameSchema, type FrameRequest, type DecodedFrame } from '../shared/analysis';

export interface AnalysisDecoder {
  frame(request: FrameRequest, signal?: AbortSignal): Promise<DecodedFrame>;
}
interface Job { request: FrameRequest; signal?: AbortSignal; resolve(result: DecodedFrame): void; reject(error: Error): void; cancel?: () => void }

/** One native decoder at a time, with cancellable clock frame requests. */
export class DecoderQueue implements AnalysisDecoder {
  private queue: Job[] = [];
  private active?: Worker;
  private closed = false;
  constructor(private readonly workerPath: string, private readonly executable: string) {}
  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue]) job.cancel?.();
    const worker = this.active;
    if (!worker) return;
    const stopped = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    worker.postMessage({ type: 'cancel' });
    await stopped;
  }
  frame(request: FrameRequest, signal?: AbortSignal): Promise<DecodedFrame> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Clock decoding cancelled'));
    return new Promise((resolve, reject) => {
      const job: Job = { request, signal, resolve, reject };
      job.cancel = () => { const index = this.queue.indexOf(job); if (index !== -1) { this.queue.splice(index, 1); signal?.removeEventListener('abort', job.cancel!); reject(new Error('Clock decoding cancelled')); } };
      signal?.addEventListener('abort', job.cancel, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  private drain(): void {
    if (this.closed || this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    job.signal?.removeEventListener('abort', job.cancel!);
    if (job.signal?.aborted) { job.reject(new Error('Clock decoding cancelled')); this.drain(); return; }
    let worker: Worker;
    try { worker = new Worker(this.workerPath, { workerData: { executable: this.executable, request: job.request } }); }
    catch (error) { job.reject(error as Error); this.drain(); return; }
    this.active = worker;
    let settled = false;
    const settle = (error?: Error, result?: DecodedFrame) => {
      if (settled) return;
      settled = true; job.signal?.removeEventListener('abort', cancel);
      if (error) job.reject(error); else job.resolve(result!);
    };
    const cancel = () => worker.postMessage({ type: 'cancel' });
    job.signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', message => {
      if (job.signal?.aborted || this.closed) { settle(new Error('Clock decoding cancelled')); return; }
      if (message?.type === 'error') settle(new Error(String(message.message)));
      if (message?.type === 'result') {
        const parsed = frameSchema.safeParse(message.result);
        if (parsed.success) settle(undefined, parsed.data); else settle(new Error('Invalid clock image from decoder worker'));
      }
    });
    worker.once('error', error => settle(error));
    worker.once('exit', () => { settle(new Error('Clock decoder stopped before completion')); this.active = undefined; this.drain(); });
    if (job.signal?.aborted) cancel();
  }
}
