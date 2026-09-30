import { Worker } from 'node:worker_threads';
import { identitySchema, type FileIdentity } from '../library/model';

interface Job { path: string; signal?: AbortSignal; progress?: (completed: number, total: number) => void; resolve(identity: FileIdentity): void; reject(error: Error): void }

/** Two bounded readers: a large recording must not starve replay identification. */
export class HashWorkers {
  private queue: Job[] = [];
  private active = new Set<Worker>();
  private closed = false;
  constructor(private readonly workerPath: string, private readonly concurrency = 2) {}

  identify(path: string, signal?: AbortSignal, progress?: Job['progress']): Promise<FileIdentity> {
    if (this.closed) return Promise.reject(new Error('File identification has stopped'));
    return new Promise((resolve, reject) => { this.queue.push({ path, signal, progress, resolve, reject }); this.drain(); });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('File identification stopped'));
    await Promise.all([...this.active].map(worker => worker.terminate()));
  }
  private drain(): void {
    while (!this.closed && this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.signal?.aborted) { job.reject(new Error('File identification cancelled')); continue; }
      let worker: Worker;
      try { worker = new Worker(this.workerPath, { workerData: { path: job.path } }); }
      catch (error) { job.reject(error as Error); continue; }
      this.active.add(worker);
      let settled = false;
      const settle = (error?: Error, identity?: FileIdentity) => {
        if (settled) return;
        settled = true;
        job.signal?.removeEventListener('abort', cancel);
        if (error) job.reject(error); else job.resolve(identity!);
        void worker.terminate();
      };
      const cancel = () => settle(new Error('File identification cancelled'));
      job.signal?.addEventListener('abort', cancel, { once: true });
      worker.on('message', message => {
        if (settled) return;
        if (message?.type === 'progress' && Number.isFinite(message.completed) && Number.isFinite(message.total)) job.progress?.(message.completed, message.total);
        else if (message?.type === 'error') settle(new Error(String(message.message)));
        else if (message?.type === 'result') {
          const parsed = identitySchema.safeParse(message.identity);
          if (parsed.success) settle(undefined, parsed.data); else settle(new Error('Invalid file identity from worker'));
        }
      });
      worker.once('error', error => settle(error));
      worker.once('exit', () => { settle(new Error('File identification stopped before completion')); this.active.delete(worker); this.drain(); });
      if (job.signal?.aborted) cancel();
    }
  }
}
