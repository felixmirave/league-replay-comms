import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayConnection, type ReplayTransport } from '../src/sync/replay';
import { playbackSchema, type ReplaySample } from '../src/shared/domain';

afterEach(() => vi.useRealTimers());
const response = { time: 10, speed: 1, paused: false, seeking: false, length: 2000 };

describe('Replay API observations', () => {
  it('validates essential fields without inventing clocks', () => {
    expect(playbackSchema.safeParse({ paused: false }).success).toBe(false);
    expect(playbackSchema.safeParse({ ...response, time: NaN }).success).toBe(false);
    expect(playbackSchema.safeParse({ ...response, speed: -1 }).success).toBe(false);
    expect(playbackSchema.parse({ time: 10, speed: 1, paused: false, length: 2000 }).seeking).toBe(false);
  });

  it('does not overlap playback requests and aborts a hung request on deadline', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    let aborted = 0;
    const transport: ReplayTransport = {
      close() {},
      get: async (path, signal) => {
        if (path === '/replay/game') return { processID: 100 };
        active++;
        maxActive = Math.max(active, maxActive);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { active--; aborted++; reject(new Error('timeout')); }, { once: true }));
      },
    };
    const errors: string[] = [];
    const connection = new ReplayConnection(transport, () => {}, error => errors.push(error), () => Date.now() / 1000);
    connection.start();
    await vi.advanceTimersByTimeAsync(950);
    expect(maxActive).toBe(1);
    expect(aborted).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    connection.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(active).toBe(0);
  });

  it('rejects post-stop responses and changes runtime identity across reconnect', async () => {
    vi.useFakeTimers();
    let fail = false;
    const samples: ReplaySample[] = [];
    const transport: ReplayTransport = { close() {}, async get(path) {
      if (path === '/replay/game') return { processID: 100 };
      if (fail) throw new Error('connection lost');
      return response;
    } };
    const connection = new ReplayConnection(transport, sample => samples.push(sample), () => {}, () => Date.now() / 1000);
    connection.start();
    await vi.advanceTimersByTimeAsync(10);
    const firstId = samples[0]!.sessionId;
    fail = true;
    await vi.advanceTimersByTimeAsync(60);
    fail = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(samples.at(-1)!.sessionId).not.toBe(firstId);
    connection.stop();
    const count = samples.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(samples).toHaveLength(count);
  });

  it('does not start playback requests after being stopped during identity lookup', async () => {
    let finishIdentity: (value: unknown) => void = () => {};
    const paths: string[] = [];
    const transport: ReplayTransport = { close() {}, async get(path) {
      paths.push(path);
      return new Promise(resolve => { finishIdentity = resolve; });
    } };
    const connection = new ReplayConnection(transport, () => {}, () => {});
    connection.start();
    connection.stop();
    finishIdentity({ processID: 100 });
    await Promise.resolve();
    await Promise.resolve();
    expect(paths).toEqual(['/replay/game']);
  });

  it('starts a new session and ignores an old identity response after a stop/restart', async () => {
    vi.useFakeTimers();
    let finishOld!: (value: unknown) => void;
    let identityReads = 0;
    const samples: ReplaySample[] = [];
    const transport: ReplayTransport = { close() {}, async get(path) {
      if (path === '/replay/game') {
        if (++identityReads === 2) return new Promise(resolve => { finishOld = resolve; });
        return { processID: 100 };
      }
      return response;
    } };
    const connection = new ReplayConnection(transport, sample => samples.push(sample), () => {}, () => Date.now() / 1000);
    connection.start(); await vi.advanceTimersByTimeAsync(10);
    const firstSession = samples[0]!.sessionId;
    await vi.advanceTimersByTimeAsync(2000);
    connection.stop(); connection.start();
    await vi.advanceTimersByTimeAsync(10);
    const resumedSession = samples.at(-1)!.sessionId;
    expect(identityReads).toBe(3);
    expect(resumedSession).not.toBe(firstSession);
    finishOld({ processID: 999 });
    await vi.advanceTimersByTimeAsync(100);
    expect(samples.at(-1)!.sessionId).toBe(resumedSession);
    connection.stop();
  });
});
