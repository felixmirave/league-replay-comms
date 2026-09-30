import { monotonicSeconds } from '../shared/domain';

export interface TraceLimits { maxEntries: number; maxBytes: number; maxPayloadBytes: number }
const defaults: TraceLimits = { maxEntries: 12_000, maxBytes: 4 * 1024 * 1024, maxPayloadBytes: 64 * 1024 };

/** Bounded diagnostics must never interrupt playback when a payload cannot be recorded. */
export class DiagnosticTrace {
  private readonly entries = new Map<number, { json: string; bytes: number }>();
  private readonly startedAtSeconds: number;
  private sequence = 0;
  private bytes = 0;
  private droppedEntries = 0;
  private omittedPayloads = 0;

  constructor(private readonly clock = monotonicSeconds, private readonly limits: TraceLimits = defaults) {
    if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 512
      || !Number.isSafeInteger(limits.maxPayloadBytes) || limits.maxPayloadBytes < 16 || limits.maxPayloadBytes > limits.maxBytes - 256) throw new Error('Invalid trace limits');
    this.startedAtSeconds = clock();
  }

  record(event: string, data: unknown, atSeconds = this.clock()): void {
    const payload = this.payload(data);
    const sequence = ++this.sequence;
    const json = JSON.stringify({ sequence, atSeconds, event, data: JSON.parse(payload) });
    const bytes = Buffer.byteLength(json);
    if (bytes > this.limits.maxBytes) { this.droppedEntries++; return; }
    this.entries.set(sequence, { json, bytes }); this.bytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      const first = this.entries.entries().next().value!;
      this.bytes -= first[1].bytes; this.entries.delete(first[0]); this.droppedEntries++;
    }
  }

  snapshot(context: unknown) {
    return { schemaVersion: 1, clock: 'sync-worker-monotonic-seconds', startedAtSeconds: this.startedAtSeconds, exportedAtSeconds: this.clock(),
      context: JSON.parse(this.payload(context)), retention: { ...this.limits, retainedBytes: this.bytes, droppedEntries: this.droppedEntries, omittedPayloads: this.omittedPayloads },
      entries: [...this.entries.values()].map(value => JSON.parse(value.json) as { sequence: number; atSeconds: number; event: string; data: unknown }) };
  }

  private payload(data: unknown): string {
    try {
      const json = JSON.stringify(data) ?? 'null';
      if (Buffer.byteLength(json) <= this.limits.maxPayloadBytes) return json;
      this.omittedPayloads++;
      return '{"omitted":"payload exceeded trace limit"}';
    } catch {
      this.omittedPayloads++;
      return '{"omitted":"payload was not serializable"}';
    }
  }
}
