export type RecoveryState = 'active' | 'suspended' | 'recovering' | 'failed';
export type RecoveryScope = 'runtime' | 'output';

export interface RecoveryActions {
  /** Synchronous: invalidate observations and terminate the owned player. */
  interrupt(reason: string, scope: RecoveryScope): void;
  drain(): Promise<void>;
  restore(): Promise<void>;
  ready(scope: RecoveryScope): void;
  failed(error: unknown): void;
  changed(): void;
}

/** Serializes physical replacement while invalidating previously accepted work. */
export class PlaybackRecovery {
  state: RecoveryState = 'active';
  generation = 0;
  private work: Promise<void> = Promise.resolve();
  private scope: RecoveryScope = 'runtime';
  private outputRestarts: number[] = [];

  constructor(private readonly actions: RecoveryActions, private readonly now = () => performance.now() / 1000) {}

  get busy(): boolean { return this.state === 'suspended' || this.state === 'recovering'; }

  assertActive(generation = this.generation, allowFailed = false): void {
    if (generation !== this.generation || (this.state !== 'active' && !(allowFailed && this.state === 'failed'))) throw new Error('Playback was interrupted. Wait for recovery, then try again.');
  }

  replacementLoaded(): void {
    if (this.state !== 'failed') return;
    this.outputRestarts = [];
    this.state = 'active'; this.actions.ready('runtime'); this.actions.changed();
  }

  suspend(reason = 'System suspended', scope: RecoveryScope = 'runtime'): void {
    if (this.state === 'suspended') return;
    this.generation++;
    this.state = 'suspended';
    this.scope = scope;
    this.actions.interrupt(reason, scope);
    this.actions.changed();
  }

  recover(reason: string, scope: RecoveryScope = 'runtime'): Promise<void> {
    if (this.state === 'recovering') {
      if (scope === 'runtime' && this.scope === 'output') this.suspend(reason);
      else return this.work;
    }
    const now = this.now();
    this.outputRestarts = scope === 'output' ? this.outputRestarts.filter(at => now - at < 10) : [];
    const repeatedFailure = scope === 'output' && this.outputRestarts.length >= 2;
    if (scope === 'output' && !repeatedFailure) this.outputRestarts.push(now);
    const previous = this.work, generation = ++this.generation;
    this.state = 'recovering';
    this.scope = scope;
    this.actions.interrupt(reason, scope);
    this.actions.changed();
    this.work = (async () => {
      // An interrupted restore may still be unwinding. Never let two restores
      // open the player concurrently, even across suspend/resume during loading.
      await previous;
      await this.actions.drain();
      if (generation !== this.generation) return;
      if (repeatedFailure) throw new Error('Audio output keeps changing. Connect a stable output device, then retry playback.');
      await this.actions.restore();
      if (generation !== this.generation) return;
      this.state = 'active';
      this.actions.ready(scope);
      this.actions.changed();
    })().catch(error => {
      if (generation !== this.generation) return;
      this.state = 'failed';
      this.actions.failed(error);
      this.actions.changed();
    });
    return this.work;
  }
}
