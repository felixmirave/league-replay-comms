import { describe, expect, it } from 'vitest';
import { DiagnosticTrace } from '../src/sync/trace';
import { diagnosticExport } from '../src/main/diagnostics';
import { userCommandSchema } from '../src/shared/protocol';

describe('Bounded diagnostic evidence', () => {
  it('retains ordered immutable records and current context after old history is evicted', () => {
    let now = 1;
    const trace = new DiagnosticTrace(() => now, { maxEntries: 3, maxBytes: 2048, maxPayloadBytes: 512 });
    const binding = { offsetSeconds: 45, sessionId: 'first' };
    trace.record('binding', binding); binding.offsetSeconds = 100;
    expect(trace.snapshot({}).entries[0]!.data).toEqual({ offsetSeconds: 45, sessionId: 'first' });
    for (let n = 0; n < 5; n++) { now++; trace.record('controller', { generation: n }); }
    const report = trace.snapshot({ binding });
    expect(report.entries.map(item => item.sequence)).toEqual([4, 5, 6]);
    expect(report.entries.map(item => item.atSeconds)).toEqual([4, 5, 6]);
    expect(report.retention.droppedEntries).toBe(3);
    expect(report.context).toEqual({ binding });
    (report.entries[0]!.data as { generation: number }).generation = 999;
    expect(trace.snapshot({}).entries[0]!.data).toEqual({ generation: 2 });
  });

  it('bounds bytes independently of entry count and records omitted/cyclic payloads without breaking playback', () => {
    const trace = new DiagnosticTrace(() => 1, { maxEntries: 100, maxBytes: 1024, maxPayloadBytes: 256 });
    for (let n = 0; n < 100; n++) trace.record('failure', { message: 'x'.repeat(180), generation: n });
    expect(trace.snapshot({}).retention.retainedBytes).toBeLessThanOrEqual(1024);
    expect(trace.snapshot({}).retention.droppedEntries).toBeGreaterThan(90);
    trace.record('large', 'x'.repeat(257));
    const cyclic: { cycle?: unknown } = {}; cyclic.cycle = cyclic;
    expect(() => trace.record('cyclic', cyclic)).not.toThrow();
    const report = trace.snapshot({});
    expect(report.entries.at(-2)!.data).toEqual({ omitted: 'payload exceeded trace limit' });
    expect(report.entries.at(-1)!.data).toEqual({ omitted: 'payload was not serializable' });
    expect(report.retention.omittedPayloads).toBe(2);
  });

  it('masks known, drive, UNC, POSIX, relative path fields and file URLs while preserving API addresses and numbers', () => {
    const value = { offsetSeconds: -12.5, path: 'relative comms.wav', entries: [
      { error: "Cannot open 'C:\\Users\\Reviewer\\recordings\\comms café.wav'" },
      { error: "Cannot open '\\\\server\\share\\comms.wav'" },
      { error: "Cannot open '//server/share/comms.wav'" },
      { error: "Cannot open '/home/reviewer/comms.wav'" },
      { error: 'frame at file:///home/reviewer/app/index.cjs:20' },
      { error: 'Cannot read a path containing "quotes" and spaces' },
      { error: 'Request https://127.0.0.1:2999/replay/playback timed out' },
    ] };
    const redacted = diagnosticExport(value, false, ['a path containing "quotes" and spaces']) as typeof value;
    expect(redacted.offsetSeconds).toBe(-12.5); expect(redacted.path).toBe('<local path>');
    for (const entry of redacted.entries.slice(0, 6)) expect(entry.error).toContain('<local path>');
    expect(JSON.stringify(redacted)).not.toContain('reviewer');
    expect(JSON.stringify(redacted)).not.toContain('Reviewer');
    expect(JSON.stringify(redacted)).not.toContain('comms');
    expect(redacted.entries.at(-1)).toEqual(value.entries.at(-1));
    expect(diagnosticExport(value, true)).toBe(value);
    expect(value.path).toBe('relative comms.wav');
  });

  it('requires a boolean for opting into path export', () => {
    expect(userCommandSchema.parse({ type: 'export-trace' })).toEqual({ type: 'export-trace' });
    expect(userCommandSchema.safeParse({ type: 'export-trace', includePaths: 'true' }).success).toBe(false);
    expect(userCommandSchema.parse({ type: 'export-trace', includePaths: true })).toEqual({ type: 'export-trace', includePaths: true });
  });
});
