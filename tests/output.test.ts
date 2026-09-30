import { describe, expect, it, vi } from 'vitest';
import { AudioOutputGuard } from '../src/sync/output';

const tracks = [{ type: 'audio', id: 2, selected: true }, { type: 'audio', id: 1, selected: false }];
const property = (name: string, data?: unknown) => ({ event: 'property-change', name, data });
const reconfig = { event: 'audio-reconfig' };

describe('audio output events and readiness', () => {
  it('accepts initialization and expected reconfiguration while invalidating older observations', () => {
    const interrupted = vi.fn(), guard = new AudioOutputGuard(interrupted);
    guard.event(property('current-ao')); guard.event(reconfig);
    guard.event(property('current-ao', 'wasapi'));
    guard.verify('wasapi', tracks, 2); guard.arm();
    const revision = guard.revision, end = guard.begin();
    guard.event(reconfig); guard.event(property('current-ao')); guard.event(property('current-ao', 'wasapi'));
    guard.verify('wasapi', tracks, 2); end();
    expect(interrupted).not.toHaveBeenCalled();
    expect(() => guard.assertStable(revision)).toThrow('changed');
    expect(() => guard.assertStable()).not.toThrow();
    guard.disarm(); guard.event(reconfig);
    expect(interrupted).not.toHaveBeenCalled();
  });

  it('handles a default switch even when driver and enumerated devices are identical, coalescing its burst', () => {
    const interrupted = vi.fn(), guard = new AudioOutputGuard(interrupted);
    guard.event(property('current-ao', 'wasapi'));
    const devices = [{ name: 'auto', description: 'Default' }, { name: 'usb', description: 'USB' }];
    guard.event(property('audio-device-list', devices)); guard.event(property('audio-device', 'auto'));
    guard.verify('wasapi', tracks, 2); guard.arm();
    guard.event(property('current-ao', 'wasapi')); guard.event(property('audio-device-list', devices));
    expect(interrupted).not.toHaveBeenCalled();
    guard.event(reconfig); guard.event(reconfig); guard.event(property('current-ao'));
    expect(interrupted).toHaveBeenCalledOnce();
    expect(interrupted.mock.calls[0]![0]).toMatchObject({ driver: 'wasapi', configuredDevice: 'auto', devices });
    expect(() => guard.verify('wasapi', tracks, 2)).toThrow('Playback stopped');
  });

  it('detects disappearance from properties or active queries and refuses null fallback and a wrong stream', () => {
    for (const signal of ['property', 'query']) {
      const interrupted = vi.fn(), guard = new AudioOutputGuard(interrupted);
      guard.event(property('current-ao', 'wasapi')); guard.verify('wasapi', tracks, 2); guard.arm();
      if (signal === 'property') guard.event(property('current-ao'));
      else expect(() => guard.verify(undefined, tracks, 2)).toThrow('No usable audio output');
      expect(interrupted).toHaveBeenCalledOnce();
    }
    const guard = new AudioOutputGuard(vi.fn());
    expect(() => guard.verify('null', tracks, 2)).toThrow('No usable audio output');
    expect(() => guard.verify('wasapi', tracks, 1)).toThrow('not active');
    expect(() => new AudioOutputGuard(vi.fn(), true).verify('null', tracks, 2)).not.toThrow();
  });

  it('does not let old operation completions suppress a new player event', () => {
    const interrupted = vi.fn(), guard = new AudioOutputGuard(interrupted);
    const oldEnd = guard.begin(); guard.reset();
    const newEnd = guard.begin(); oldEnd();
    guard.verify('wasapi', tracks, 2); guard.arm(); guard.event(reconfig);
    expect(interrupted).not.toHaveBeenCalled();
    newEnd(); guard.event(reconfig);
    expect(interrupted).toHaveBeenCalledOnce();
    guard.reset(); guard.verify('wasapi', tracks, 2); guard.arm();
    guard.event(reconfig);
    expect(interrupted).toHaveBeenCalledTimes(2);
  });
});
