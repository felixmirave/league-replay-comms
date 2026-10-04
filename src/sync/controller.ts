import type { AudioSample, Binding, ControllerEvent, PlaybackAction, ReplaySample, SyncStatus } from '../shared/domain';

export interface ControllerConfig {
  freshnessSeconds: number;
  maxRoundTripSeconds: number;
  deadbandSeconds: number;
  jumpSeconds: number;
  resyncSeconds: number;
  settleSeconds: number;
  seekTimeoutSeconds: number;
  maxRateCorrection: number;
  minSpeed: number;
  maxSpeed: number;
}

export const initialControllerConfig: ControllerConfig = {
  freshnessSeconds: 0.3, maxRoundTripSeconds: 0.15, deadbandSeconds: 0.025,
  jumpSeconds: 0.12, resyncSeconds: 0.1, settleSeconds: 0.075,
  seekTimeoutSeconds: 2, maxRateCorrection: 0.02, minSpeed: 0.5, maxSpeed: 2,
};

/** Pure control decisions. The engine adapter serializes actions and verifies seeks. */
export class Synchronizer {
  private replay?: ReplaySample;
  private audio?: AudioSample;
  private binding?: Binding;
  private mode: 'follow' | 'preview' = 'preview';
  private generation = 0;
  private pending?: { generation: number; startedAtSeconds: number };
  private recovery = true;
  private settledSince = Infinity;
  private lastProgressAt = -Infinity;
  private fault?: string;
  private commandedPaused = true;
  private commandedRate = 1;
  private attempts = 0;
  private preparationSeconds = 0;
  private starting?: { position: number; at: number; delay: number; rate: number };
  private status: SyncStatus = { state: 'preview', reason: 'Preview controls the recording', generation: 0 };

  constructor(private readonly config: ControllerConfig = initialControllerConfig) {}

  snapshot(): SyncStatus { return { ...this.status }; }

  update(event: ControllerEvent, now: number): PlaybackAction[] {
    const actions: PlaybackAction[] = [];
    if (event.type === 'reset') {
      // The caller has terminated the old physical player before clearing its
      // pending work. Neither replay nor media observations survive replacement.
      this.replay = undefined; this.audio = undefined; this.binding = undefined;
      this.pending = undefined; this.fault = undefined;
      this.commandedPaused = true; this.commandedRate = NaN;
      this.lastProgressAt = -Infinity;
      this.invalidate(now);
    } else if (event.type === 'bind') {
      const b = event.binding;
      if (![b.offsetSeconds, b.startSeconds, b.endSeconds].every(Number.isFinite) || b.startSeconds >= b.endSeconds) throw new Error('Invalid recording range or offset');
      this.binding = { ...b };
      this.invalidate(now);
      this.fault = undefined;
    } else if (event.type === 'unbind') {
      this.binding = undefined;
      this.invalidate(now);
    } else if (event.type === 'mode') {
      this.mode = event.mode;
      this.invalidate(now);
      // Preview may have changed the engine independently of the last commands.
      this.commandedPaused = false;
      this.commandedRate = NaN;
      this.pause(actions, true);
    } else if (event.type === 'replay') {
      this.acceptReplay(event.sample, now);
    } else if (event.type === 'audio') {
      if (this.validAudio(event.sample, now) && (!this.audio || event.sample.observedAtSeconds >= this.audio.observedAtSeconds)) {
        if (this.audio && event.sample.outputRevision !== this.audio.outputRevision) this.invalidate(now);
        this.audio = event.sample;
        if (!event.sample.paused) this.starting = undefined;
      }
    } else if (event.type === 'seek-complete') {
      if (this.pending?.generation === event.generation) {
        const elapsed = Math.max(0, now - this.pending.startedAtSeconds);
        this.pending = undefined;
        if (event.generation === this.generation && this.validAudio(event.sample, now)) {
          this.preparationSeconds = Math.max(this.preparationSeconds, elapsed);
          this.audio = event.sample;
          this.recovery = false;
        }
      }
    } else if (event.type === 'seek-failed') {
      if (this.pending?.generation === event.generation) this.pending = undefined;
      if (event.generation === this.generation) {
        this.fault = event.message;
        this.invalidate(now);
      }
    } else if (event.type === 'failure') {
      this.fault = event.message;
      this.invalidate(now);
    } else if (event.type === 'retry') {
      this.fault = undefined;
      this.invalidate(now);
    }

    const setStatus = (state: SyncStatus['state'], reason: string, extra: Partial<SyncStatus> = {}) => {
      this.status = { state, reason, generation: this.generation, ...extra };
    };
    if (this.fault) {
      this.pause(actions, true);
      setStatus('error', this.fault);
      return actions;
    }
    if (this.mode === 'preview') {
      setStatus('preview', 'Preview controls the recording');
      return actions;
    }
    const replay = this.replay;
    if (!replay || now - replay.receivedAtSeconds >= this.config.freshnessSeconds) {
      this.pause(actions, true);
      if (!this.recovery) this.invalidate(now);
      setStatus('waiting', 'Waiting for a fresh replay clock');
      return actions;
    }
    const binding = this.binding;
    if (!binding || binding.replaySessionId !== replay.sessionId) {
      this.pause(actions, true);
      setStatus('needs-alignment', 'Select this replay and align a recording');
      return actions;
    }
    const target = this.projectReplay(replay, now) + binding.offsetSeconds;
    if (target < binding.startSeconds || target >= binding.endSeconds) {
      this.pause(actions, true);
      if (!this.recovery) this.invalidate(now);
      setStatus('outside-recording', 'This replay moment is outside the recording', { targetSeconds: target });
      return actions;
    }
    if (!replay.paused && (replay.speed < this.config.minSpeed || replay.speed > this.config.maxSpeed)) {
      this.pause(actions, true);
      if (!this.recovery) this.invalidate(now);
      setStatus('unsupported-speed', 'Comms paused at this navigation speed', { targetSeconds: target });
      return actions;
    }
    if (replay.seeking || (!replay.paused && now - this.lastProgressAt >= this.config.freshnessSeconds)) {
      this.pause(actions, true);
      if (!this.recovery) this.invalidate(now);
      setStatus('recovering', 'Waiting for the replay to settle', { targetSeconds: target });
      return actions;
    }
    const nominalRate = replay.speed || 1;
    const audio = this.audio;
    const freshAudio = audio && this.validAudio(audio, now) && !audio.seeking;
    // The first playing observation may arrive after another replay update.
    // Until then, project the scheduled audible start rather than treating its
    // still-paused observation as audio that is ahead of League.
    const position = freshAudio ? this.starting && !this.commandedPaused && audio.paused
      ? this.starting.position + (now - this.starting.at - this.starting.delay) * this.starting.rate
      : audio.positionSeconds + (audio.paused ? 0 : audio.rate * (now - audio.observedAtSeconds)) : NaN;
    const startDelay = this.commandedPaused && audio?.paused && !replay.paused && Number.isFinite(audio.startDelaySeconds)
      ? Math.max(0, audio.startDelaySeconds!) : 0;
    const error = target + startDelay * nominalRate - position;
    if (this.pending) {
      this.pause(actions, true);
      if (now - this.pending.startedAtSeconds > this.config.seekTimeoutSeconds) {
        this.fault = 'Recording seek timed out. Retry playback.';
        setStatus('error', this.fault);
      } else setStatus('recovering', 'Seeking the recording', { targetSeconds: target });
      return actions;
    }
    // A prepared seek can finish sooner than the previous one. Keep its future
    // position paused until League reaches it rather than throwing that work away.
    if (!this.recovery && this.commandedPaused && freshAudio && audio.paused && !replay.paused
      && error < -this.config.deadbandSeconds && -error <= (this.preparationSeconds + startDelay) * nominalRate + this.config.resyncSeconds) {
      this.pause(actions, true);
      setStatus('recovering', 'Waiting for the replay to reach prepared audio', { targetSeconds: target });
      return actions;
    }
    if (this.recovery || !freshAudio || Math.abs(error) > this.config.resyncSeconds) {
      this.pause(actions, true);
      this.rate(actions, nominalRate);
      setStatus('recovering', 'Aligning the recording', { targetSeconds: target });
      if (now - this.settledSince >= this.config.settleSeconds) {
        if (++this.attempts > 4) {
          this.fault = 'Recording cannot catch up. Retry playback.';
          setStatus('error', this.fault);
        } else {
          this.pending = { generation: this.generation, startedAtSeconds: now };
          // Preparation runs while League advances. Aim ahead by its measured
          // duration; paused replays always seek to the exact current position.
          const lead = replay.paused || this.preparationSeconds <= this.config.deadbandSeconds ? 0 : this.preparationSeconds * nominalRate;
          actions.push({ type: 'seek', targetSeconds: Math.min(binding.endSeconds - 0.001, target + lead + startDelay * nominalRate), generation: this.generation });
        }
      }
      return actions;
    }
    this.attempts = 0;
    const uncertainty = (replay.receivedAtSeconds - replay.sentAtSeconds) / 2 * nominalRate + (audio?.uncertaintySeconds ?? 0);
    const deadband = Math.max(this.config.deadbandSeconds, uncertainty);
    const correction = !replay.paused && Math.abs(error) > deadband
      ? Math.max(-this.config.maxRateCorrection, Math.min(this.config.maxRateCorrection, error / nominalRate)) : 0;
    this.rate(actions, nominalRate * (1 + correction));
    if (this.commandedPaused && !replay.paused && audio) {
      this.starting = { position: audio.positionSeconds, at: now, delay: startDelay, rate: this.commandedRate };
    }
    this.pause(actions, replay.paused);
    setStatus(replay.paused ? 'paused' : 'following', replay.paused ? 'Replay paused' : 'Following replay', { targetSeconds: target, errorSeconds: error, rate: this.commandedRate });
    return actions;
  }

  private invalidate(now: number): void {
    this.generation++;
    this.recovery = true;
    this.settledSince = now;
    this.attempts = 0;
    this.preparationSeconds = 0;
    // Keep physical work pending until its completion. Its generation is now obsolete.
  }

  private acceptReplay(sample: ReplaySample, now: number): void {
    const rtt = sample.receivedAtSeconds - sample.sentAtSeconds;
    if (!Object.values(sample).filter(v => typeof v === 'number').every(Number.isFinite) || rtt < 0 || rtt > this.config.maxRoundTripSeconds || sample.receivedAtSeconds > now || now - sample.receivedAtSeconds >= this.config.freshnessSeconds) return;
    const previous = this.replay;
    if (previous && sample.receivedAtSeconds <= previous.receivedAtSeconds) return;
    const changedSession = previous && previous.sessionId !== sample.sessionId;
    if (changedSession) this.binding = undefined;
    const previousAtSample = previous ? this.projectReplay(previous, this.sampleTime(sample)) : 0;
    const changedState = previous && (previous.paused !== sample.paused || previous.speed !== sample.speed);
    const jumped = previous && !changedState && Math.abs(sample.timeSeconds - previousAtSample) > this.config.jumpSeconds;
    if (!previous || changedSession || jumped || sample.seeking || previous.seeking || changedState) this.invalidate(now);
    if (!previous || changedSession || sample.paused || sample.timeSeconds !== previous.timeSeconds) this.lastProgressAt = now;
    this.replay = sample;
  }

  private validAudio(sample: AudioSample, now: number): boolean {
    return Number.isFinite(sample.positionSeconds) && Number.isFinite(sample.rate) && Number.isFinite(sample.observedAtSeconds)
      && sample.observedAtSeconds <= now && now - sample.observedAtSeconds < this.config.freshnessSeconds;
  }
  private sampleTime(sample: ReplaySample): number { return (sample.sentAtSeconds + sample.receivedAtSeconds) / 2; }
  private projectReplay(sample: ReplaySample, at: number): number {
    return sample.timeSeconds + (sample.paused || sample.seeking ? 0 : Math.max(0, at - this.sampleTime(sample)) * sample.speed);
  }
  private pause(actions: PlaybackAction[], paused: boolean): void {
    if (paused) this.starting = undefined;
    if (this.commandedPaused !== paused) { actions.push({ type: 'pause', paused }); this.commandedPaused = paused; }
  }
  private rate(actions: PlaybackAction[], rate: number): void {
    if (Math.abs(this.commandedRate - rate) > 0.0001 || !Number.isFinite(this.commandedRate)) { actions.push({ type: 'rate', rate }); this.commandedRate = rate; }
  }
}
