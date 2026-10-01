import { describe, expect, it } from 'vitest';
import { Synchronizer } from '../src/sync/controller';
import type { AudioSample, PlaybackAction, ReplaySample } from '../src/shared/domain';

const replay = (now: number, time = now, extra: Partial<ReplaySample> = {}): ReplaySample => ({
  sessionId: 'match-a', timeSeconds: time, sentAtSeconds: now, receivedAtSeconds: now,
  speed: 1, paused: false, seeking: false, lengthSeconds: 3000, ...extra,
});
const audio = (now: number, position: number, extra: Partial<AudioSample> = {}): AudioSample => ({
  positionSeconds: position, observedAtSeconds: now, uncertaintySeconds: 0, paused: false, seeking: false, rate: 1, ...extra,
});
function start(offsetSeconds = 45) {
  const sync = new Synchronizer();
  sync.update({ type: 'replay', sample: replay(0) }, 0);
  sync.update({ type: 'bind', binding: { replaySessionId: 'match-a', offsetSeconds, startSeconds: 0, endSeconds: 4000 } }, 0);
  sync.update({ type: 'mode', mode: 'follow' }, 0);
  const actions = sync.update({ type: 'replay', sample: replay(0.1) }, 0.1);
  return { sync, seek: actions.find(a => a.type === 'seek') as Extract<PlaybackAction, { type: 'seek' }> };
}
function following() {
  const { sync, seek } = start();
  expect(seek.targetSeconds).toBeCloseTo(45.1);
  sync.update({ type: 'seek-complete', generation: seek.generation, sample: audio(0.1, 45.1, { paused: true }) }, 0.1);
  return sync;
}

describe('replay following', () => {
  it('uses recording = replay + offset and holds a full match without corrective seeks', () => {
    const sync = following();
    for (let frame = 3; frame <= 48_000; frame++) {
      const now = frame * 0.05;
      const a = sync.update({ type: 'audio', sample: audio(now, now + 45) }, now);
      const b = sync.update({ type: 'replay', sample: replay(now) }, now);
      expect([...a, ...b].some(action => action.type === 'seek')).toBe(false);
    }
    expect(sync.snapshot().state).toBe('following');
    expect(sync.snapshot().errorSeconds).toBeCloseTo(0);
  });

  it.each([-.1, .1, .01])('applies a live offset change of %s seconds while continuing to follow', change => {
    const sync = following();
    sync.update({ type: 'unbind' }, .15);
    sync.update({ type: 'bind', binding: { replaySessionId: 'match-a', offsetSeconds: 45 + change, startSeconds: 0, endSeconds: 4000 } }, .15);
    const actions = sync.update({ type: 'replay', sample: replay(.25) }, .25);
    const seek = actions.find(action => action.type === 'seek');
    expect(seek).toBeDefined();
    if (seek?.type !== 'seek') throw new Error('Expected a new seek for the changed offset');
    expect(seek.targetSeconds).toBeCloseTo(45.25 + change);
    const completion = sync.update({ type: 'seek-complete', generation: seek.generation, sample: audio(.25, seek.targetSeconds, { paused: true }) }, .25);
    expect(completion).toContainEqual({ type: 'pause', paused: false });
    expect(sync.snapshot().state).toBe('following');
  });

  it('stops on a hung replay request without waiting for an error callback', () => {
    const sync = following();
    const actions = sync.update({ type: 'tick' }, 0.401);
    expect(actions).toContainEqual({ type: 'pause', paused: true });
    expect(sync.snapshot().state).toBe('waiting');
  });

  it('never resumes an obsolete seek during scrubbing and serializes physical seeks', () => {
    const { sync, seek } = start();
    const actions = sync.update({ type: 'replay', sample: replay(0.15, 400) }, 0.15);
    expect(actions.some(a => a.type === 'seek')).toBe(false);
    const completion = sync.update({ type: 'seek-complete', generation: seek.generation, sample: audio(0.16, 45.1, { paused: true }) }, 0.16);
    expect(completion).not.toContainEqual({ type: 'pause', paused: false });
    const newer = sync.update({ type: 'replay', sample: replay(0.25, 400.1) }, 0.25);
    expect(newer.find(a => a.type === 'seek')).toMatchObject({ targetSeconds: 445.1 });
  });

  it('invalidates association on a new replay session', () => {
    const sync = following();
    const actions = sync.update({ type: 'replay', sample: replay(0.15, 0, { sessionId: 'match-b' }) }, 0.15);
    expect(actions).toContainEqual({ type: 'pause', paused: true });
    expect(sync.snapshot().state).toBe('needs-alignment');
  });

  it('pauses immediately and does not unpause after a paused seek', () => {
    const sync = following();
    expect(sync.update({ type: 'replay', sample: replay(0.15, 50, { paused: true }) }, 0.15)).toContainEqual({ type: 'pause', paused: true });
    const actions = sync.update({ type: 'replay', sample: replay(0.25, 50, { paused: true }) }, 0.25);
    const seek = actions.find(a => a.type === 'seek');
    expect(seek).toBeDefined();
    if (seek?.type !== 'seek') throw new Error('Expected seek');
    const completion = sync.update({ type: 'seek-complete', generation: seek.generation, sample: audio(0.26, 95, { paused: true }) }, 0.26);
    expect(completion).not.toContainEqual({ type: 'pause', paused: false });
    expect(sync.snapshot().state).toBe('paused');
  });

  it('leaves deliberate preview alone when replay observations stop', () => {
    const sync = following();
    sync.update({ type: 'mode', mode: 'preview' }, 0.2);
    expect(sync.update({ type: 'tick' }, 5)).toEqual([]);
    expect(sync.snapshot().state).toBe('preview');
  });

  it('silences targets before the recording begins rather than clamping', () => {
    const { sync, seek } = start(-120);
    expect(seek).toBeUndefined();
    expect(sync.snapshot().state).toBe('outside-recording');
  });

  it('rejects delayed replay observations and suppresses unvalidated navigation speeds', () => {
    const sync = following();
    sync.update({ type: 'audio', sample: audio(0.2, 45.2) }, 0.2);
    sync.update({ type: 'replay', sample: replay(0.05, 200) }, 0.2);
    expect(sync.snapshot().state).toBe('following');
    expect(sync.update({ type: 'replay', sample: replay(0.25, 0.25, { speed: 8 }) }, 0.25)).toContainEqual({ type: 'pause', paused: true });
    expect(sync.snapshot().state).toBe('unsupported-speed');
  });

  it('uses a bounded speed correction with the correct sign for small drift', () => {
    const sync = following();
    sync.update({ type: 'audio', sample: audio(0.15, 45.1) }, 0.15);
    const state = sync.snapshot();
    expect(state.state).toBe('following');
    expect(state.rate).toBeGreaterThan(1);
    expect(state.rate).toBeLessThanOrEqual(1.02);
  });

  it('can retry after a failed physical seek without retaining a dead pending operation', () => {
    const { sync, seek } = start();
    sync.update({ type: 'seek-failed', generation: seek.generation, message: 'Decoder failed' }, 0.11);
    expect(sync.snapshot().state).toBe('error');
    sync.update({ type: 'retry' }, 0.12);
    const actions = sync.update({ type: 'replay', sample: replay(0.25) }, 0.25);
    expect(actions.some(action => action.type === 'seek')).toBe(true);
  });

  it('discards pre-interruption clocks, binding, and physical seek completion before following again', () => {
    const { sync, seek } = start();
    sync.update({ type: 'reset' }, 100);
    expect(sync.snapshot().state).toBe('waiting');
    expect(sync.update({ type: 'seek-complete', generation: seek.generation, sample: audio(100, 45.1, { paused: true }) }, 100)).toEqual([]);
    sync.update({ type: 'replay', sample: replay(100.1, 500, { sessionId: 'after-sleep' }) }, 100.1);
    expect(sync.snapshot().state).toBe('needs-alignment');
    sync.update({ type: 'bind', binding: { replaySessionId: 'after-sleep', offsetSeconds: 45, startSeconds: 0, endSeconds: 4000 } }, 100.1);
    const actions = sync.update({ type: 'replay', sample: replay(100.2, 500.1, { sessionId: 'after-sleep' }) }, 100.2);
    const recovered = actions.find(action => action.type === 'seek');
    expect(recovered).toMatchObject({ targetSeconds: 545.1 });
    expect(actions).not.toContainEqual({ type: 'pause', paused: false });
    if (recovered?.type !== 'seek') throw new Error('Expected a fresh physical seek');
    const ready = sync.update({ type: 'seek-complete', generation: recovered.generation, sample: audio(100.2, 545.1, { paused: true }) }, 100.2);
    expect(ready).toContainEqual({ type: 'pause', paused: false });
  });

  it('requires a new seek when fresh observations belong to a reconfigured output', () => {
    const { sync, seek } = start();
    sync.update({ type: 'seek-complete', generation: seek.generation, sample: audio(0.1, 45.1, { paused: true, outputRevision: 3 }) }, 0.1);
    const changed = sync.update({ type: 'audio', sample: audio(0.15, 45.15, { outputRevision: 4 }) }, 0.15);
    expect(changed).toContainEqual({ type: 'pause', paused: true });
    expect(sync.snapshot().state).toBe('recovering');
    const actions = sync.update({ type: 'replay', sample: replay(0.25) }, 0.25);
    expect(actions.some(action => action.type === 'seek')).toBe(true);
    expect(actions).not.toContainEqual({ type: 'pause', paused: false });
  });
});
