import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** JSON lines may be fragmented or combined; command replies and events interleave. */
export class MpvIpc extends EventEmitter {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly socket: Duplex, private readonly timeoutMs = 2000) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.consume(chunk));
    socket.on('error', error => this.close(error));
    socket.on('close', () => this.close(new Error('Media engine connection closed')));
  }

  command(command: readonly unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Media engine disconnected'));
    if (this.pending.size >= 64) return Promise.reject(new Error('Media engine command queue is full'));
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Media command timed out: ${String(command[0])}`)); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ command, request_id: requestId }) + '\n', error => {
        if (error) this.close(error);
      });
    });
  }

  close(error = new Error('Media engine connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.socket.destroy();
    this.emit('disconnect', error);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) { this.close(new Error('Media engine message exceeded limit')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        const decoded: unknown = JSON.parse(line);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
        message = decoded as Record<string, unknown>;
      } catch { this.close(new Error('Malformed media engine message')); return; }
      if (typeof message.request_id === 'number') {
        const pending = this.pending.get(message.request_id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.request_id);
        if (message.error === 'success') pending.resolve(message.data);
        else pending.reject(new Error(`Media engine: ${String(message.error)}`));
      } else if (typeof message.event === 'string') this.emit('event', message);
    }
  }
}
