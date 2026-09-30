import { describe, expect, it, vi } from 'vitest';
import { PlaybackRecovery } from '../src/sync/recovery';

const deferred = () => { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const actions = { interrupt: vi.fn(), drain: vi.fn(async () => {}), restore: vi.fn(async () => {}), ready: vi.fn(), failed: vi.fn(), changed: vi.fn() };
  return { actions, recovery: new PlaybackRecovery(actions) };
}

describe('playback interruption recovery', () => {
  it('stops physical output immediately, rejects old commands, and waits for accepted work before restoring', async () => {
    const { actions, recovery } = fixture(), draining = deferred();
    actions.drain.mockReturnValue(draining.promise);
    const oldGeneration = recovery.generation;
    recovery.suspend();
    expect(actions.interrupt).toHaveBeenCalledWith('System suspended', 'runtime');
    expect(() => recovery.assertActive(oldGeneration)).toThrow('interrupted');
    expect(actions.restore).not.toHaveBeenCalled();
    const resumed = recovery.recover('System resumed');
    expect(recovery.recover('Duplicate resume')).toBe(resumed);
    await vi.waitFor(() => expect(actions.drain).toHaveBeenCalledOnce());
    expect(actions.restore).not.toHaveBeenCalled();
    draining.resolve(); await resumed;
    expect(actions.restore).toHaveBeenCalledOnce();
    expect(actions.ready).toHaveBeenCalledOnce();
    expect(recovery.state).toBe('active');
    expect(() => recovery.assertActive(oldGeneration)).toThrow('interrupted');
    expect(() => recovery.assertActive()).not.toThrow();
  });

  it('does not restore after another suspend while draining', async () => {
    const { actions, recovery } = fixture(), draining = deferred();
    actions.drain.mockReturnValue(draining.promise);
    const resumed = recovery.recover('Long timer gap');
    await vi.waitFor(() => expect(actions.drain).toHaveBeenCalledOnce());
    recovery.suspend(); recovery.suspend();
    draining.resolve(); await resumed;
    expect(actions.restore).not.toHaveBeenCalled();
    expect(actions.ready).not.toHaveBeenCalled();
    expect(actions.interrupt).toHaveBeenCalledTimes(2);
    expect(recovery.state).toBe('suspended');
  });

  it('serializes a second recovery behind an interrupted restore and rejects obsolete completion', async () => {
    const { actions, recovery } = fixture(), restoring = deferred();
    actions.restore.mockReturnValueOnce(restoring.promise);
    const first = recovery.recover('System resumed');
    await vi.waitFor(() => expect(actions.restore).toHaveBeenCalledOnce());
    recovery.suspend();
    const second = recovery.recover('System resumed again');
    await Promise.resolve(); expect(actions.restore).toHaveBeenCalledOnce();
    restoring.reject(new Error('Old player was terminated'));
    await first; await second;
    expect(actions.restore).toHaveBeenCalledTimes(2);
    expect(actions.ready).toHaveBeenCalledOnce();
    expect(actions.failed).not.toHaveBeenCalled();
    expect(recovery.state).toBe('active');
  });

  it('keeps failed restoration silent and allows a deliberate retry', async () => {
    const { actions, recovery } = fixture();
    const failure = new Error('Recording is unavailable');
    actions.restore.mockRejectedValueOnce(failure);
    await recovery.recover('Retry playback');
    expect(recovery.state).toBe('failed');
    expect(actions.failed).toHaveBeenCalledWith(failure);
    expect(actions.ready).not.toHaveBeenCalled();
    expect(() => recovery.assertActive()).toThrow('interrupted');
    await recovery.recover('Retry playback');
    expect(recovery.state).toBe('active');
    expect(actions.ready).toHaveBeenCalledOnce();
  });

  it('retains a device-only scope but upgrades to runtime invalidation when interrupted by sleep', async () => {
    const { actions, recovery } = fixture(), restoring = deferred();
    await recovery.recover('Device changed', 'output');
    expect(actions.ready).toHaveBeenLastCalledWith('output');
    actions.restore.mockReturnValueOnce(restoring.promise);
    const device = recovery.recover('Device removed', 'output');
    await vi.waitFor(() => expect(actions.restore).toHaveBeenCalledTimes(2));
    const resume = recovery.recover('Playback timer was interrupted');
    expect(actions.interrupt).toHaveBeenLastCalledWith('Playback timer was interrupted', 'runtime');
    restoring.reject(new Error('Old output stopped'));
    await device; await resume;
    expect(actions.restore).toHaveBeenCalledTimes(3);
    expect(actions.ready).toHaveBeenLastCalledWith('runtime');
    expect(actions.failed).not.toHaveBeenCalled();
  });

  it('bounds automatic output restarts while keeping deliberate retry available', async () => {
    const { actions } = fixture();
    let now = 0;
    const recovery = new PlaybackRecovery(actions, () => now);
    await recovery.recover('Device changed', 'output');
    now = 1; await recovery.recover('Device changed again', 'output');
    now = 2; await recovery.recover('Device is unstable', 'output');
    expect(actions.restore).toHaveBeenCalledTimes(2);
    expect(recovery.state).toBe('failed');
    expect(actions.failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('keeps changing') }));
    await recovery.recover('Retry playback');
    expect(recovery.state).toBe('active');
    await recovery.recover('Another device change', 'output');
    expect(actions.restore).toHaveBeenCalledTimes(4);
    now = 20; await recovery.recover('Later independent change', 'output');
    expect(recovery.state).toBe('active');
  });
});
