import type { AudioOutputState as OutputState } from '../shared/domain';
export type { AudioOutputState as OutputState } from '../shared/domain';

/** Interprets output events without confusing player initialization with hotplug. */
export class AudioOutputGuard {
  private armed = false;
  private expected = new Set<symbol>();
  private values = new Map<string, string>();
  private state: OutputState = { revision: 0, devices: [] };

  constructor(private readonly interrupted: (state: OutputState) => void, private readonly allowNull = false) {}

  snapshot(): OutputState { return structuredClone(this.state); }
  get revision(): number { return this.state.revision; }
  get changing(): boolean { return this.expected.size > 0; }

  reset(preserveConfiguration = false): void {
    this.armed = false; this.expected.clear();
    if (!preserveConfiguration) this.values.clear();
    this.state = { revision: this.state.revision + 1, devices: preserveConfiguration ? this.state.devices : [], configuredDevice: preserveConfiguration ? this.state.configuredDevice : undefined };
  }

  begin(): () => void {
    const token = Symbol();
    this.expected.add(token);
    return () => this.expected.delete(token);
  }

  event(event: Record<string, unknown>): void {
    if (event.event === 'audio-reconfig') this.changed('Audio output was reconfigured');
    if (event.event !== 'property-change' || typeof event.name !== 'string') return;
    const name = event.name;
    if (!['current-ao', 'audio-device', 'audio-device-list'].includes(name)) return;
    const serialized = JSON.stringify(event.data) ?? 'unavailable';
    const previous = this.values.get(name);
    this.values.set(name, serialized);
    if (name === 'current-ao') this.state.driver = typeof event.data === 'string' ? event.data : undefined;
    if (name === 'audio-device') this.state.configuredDevice = typeof event.data === 'string' ? event.data : undefined;
    if (name === 'audio-device-list') this.state.devices = Array.isArray(event.data) ? event.data.filter((device): device is { name: string; description: string } =>
      !!device && typeof device === 'object' && typeof device.name === 'string' && typeof device.description === 'string').map(device => ({ name: device.name, description: device.description })) : [];
    // Initial property notifications are baselines, not device changes.
    if (previous !== undefined && previous !== serialized) this.changed('Audio output configuration changed');
  }

  verify(driver: unknown, tracks: unknown, selectedId: number | undefined): void {
    this.assertStable();
    this.state.driver = typeof driver === 'string' ? driver : undefined;
    let error: string | undefined;
    if (typeof driver !== 'string' || !driver || (driver === 'null' && !this.allowNull)) error = 'No usable audio output. Connect an output device and retry playback.';
    else if (!Array.isArray(tracks) || !tracks.some(track => track?.type === 'audio' && track.id === selectedId && track.selected === true)) error = 'The selected audio track is not active. Retry playback.';
    if (error) {
      if (this.armed && !this.changing) this.changed(error);
      throw new Error(error);
    }
  }

  arm(): void { this.assertStable(); this.armed = true; }
  disarm(): void { this.armed = false; }

  assertStable(revision = this.revision): void {
    if (this.state.error) throw new Error(this.state.error);
    if (revision !== this.revision) throw new Error('Audio output changed during the operation');
  }

  private changed(reason: string): void {
    this.state.revision++;
    if (!this.armed || this.changing || this.state.error) return;
    this.state.error = `${reason}. Playback stopped; retry if recovery fails.`;
    this.interrupted(this.snapshot());
  }
}
