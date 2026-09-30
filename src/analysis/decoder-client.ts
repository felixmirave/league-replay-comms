import { Worker } from 'node:worker_threads';
import { frameSchema, waveformSchema, type DecodeRequest, type DecodeResult, type FrameRequest, type PreviewFrame, type WaveformChunk, type WaveformRequest } from '../shared/analysis';

export interface PreviewDecoder {
  frame(request: FrameRequest, signal?: AbortSignal): Promise<PreviewFrame>;
  waveform(request: WaveformRequest, signal?: AbortSignal): Promise<WaveformChunk>;
}
interface Job { request: DecodeRequest; signal?: AbortSignal; resolve(result: DecodeResult): void; reject(error: Error): void; cancel?: () => void }

/** One native decoder at a time; interactive frames precede background chunks. */
export class DecoderQueue implements PreviewDecoder {
  private queue: Job[] = [];
  private active?: Worker;
  private closed = false;
  constructor(private readonly workerPath: string, private readonly executable: string) {}
  frame(request: FrameRequest, signal?: AbortSignal): Promise<PreviewFrame> { return this.submit(request, signal) as Promise<PreviewFrame>; }
  waveform(request: WaveformRequest, signal?: AbortSignal): Promise<WaveformChunk> { return this.submit(request, signal) as Promise<WaveformChunk>; }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue]) job.cancel?.();
    const worker = this.active;
    if (!worker) return;
    const stopped = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    worker.postMessage({ type: 'cancel' });
    await stopped;
  }
  private submit(request: DecodeRequest, signal?: AbortSignal): Promise<DecodeResult> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Preview analysis cancelled'));
    return new Promise((resolve, reject) => {
      const job: Job = { request, signal, resolve, reject };
      job.cancel = () => { const index = this.queue.indexOf(job); if (index !== -1) { this.queue.splice(index, 1); signal?.removeEventListener('abort', job.cancel!); reject(new Error('Preview analysis cancelled')); } };
      signal?.addEventListener('abort', job.cancel, { once: true });
      this.queue.push(job);
      const priority = (job: Job) => job.request.kind === 'waveform' ? 2 : job.request.processing === 'clock' ? 1 : 0;
      this.queue.sort((a, b) => priority(a) - priority(b));
      this.drain();
    });
  }
  private drain(): void {
    if (this.closed || this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    job.signal?.removeEventListener('abort', job.cancel!);
    if (job.signal?.aborted) { job.reject(new Error('Preview analysis cancelled')); this.drain(); return; }
    let worker: Worker;
    try { worker = new Worker(this.workerPath, { workerData: { executable: this.executable, request: job.request } }); }
    catch (error) { job.reject(error as Error); this.drain(); return; }
    this.active = worker;
    let settled = false;
    const settle = (error?: Error, result?: DecodeResult) => {
      if (settled) return;
      settled = true; job.signal?.removeEventListener('abort', cancel);
      if (error) job.reject(error); else job.resolve(result!);
    };
    const cancel = () => worker.postMessage({ type: 'cancel' });
    job.signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', message => {
      if (job.signal?.aborted || this.closed) { settle(new Error('Preview analysis cancelled')); return; }
      if (message?.type === 'error') settle(new Error(String(message.message)));
      if (message?.type === 'result') {
        const parsed = (job.request.kind === 'frame' ? frameSchema : waveformSchema).safeParse(message.result);
        if (parsed.success) settle(undefined, parsed.data); else settle(new Error('Invalid preview from decoder worker'));
      }
    });
    worker.once('error', error => settle(error));
    worker.once('exit', () => { settle(new Error('Preview decoder stopped before completion')); this.active = undefined; this.drain(); });
    if (job.signal?.aborted) cancel();
  }
}
