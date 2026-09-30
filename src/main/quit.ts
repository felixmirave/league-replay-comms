export type ExitDecision = 'retry' | 'cancel' | 'discard';
interface ExitActions {
  freeze(value: boolean): void;
  drain(): Promise<void>;
  silence(): Promise<void>;
  prepare(): Promise<void>;
  retry(): Promise<void>;
  unsaved(): string | undefined;
  decide(message: string): Promise<ExitDecision>;
  resume(): void;
  finish(): Promise<void>;
  failed(error: unknown): void;
}

/** Coalesces window-close/app-quit requests and never times out a durable edit. */
export class QuitCoordinator {
  private running?: Promise<void>;
  constructor(private readonly actions: ExitActions) {}
  request(): Promise<void> {
    if (this.running) return this.running;
    this.actions.freeze(true);
    const operation = this.run().finally(() => { this.running = undefined; });
    this.running = operation;
    return operation;
  }
  private async run(): Promise<void> {
    try {
      await Promise.all([this.actions.drain(), this.actions.silence()]);
      await this.actions.prepare();
      for (let message = this.actions.unsaved(); message; message = this.actions.unsaved()) {
        const choice = await this.actions.decide(message);
        if (choice === 'cancel') { this.actions.resume(); this.actions.freeze(false); return; }
        if (choice === 'discard') break;
        await this.actions.retry();
      }
      await this.actions.finish();
    } catch (error) {
      this.actions.resume(); this.actions.freeze(false); this.actions.failed(error);
    }
  }
}
