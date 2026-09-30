import { describe, expect, it, vi } from 'vitest';
import { QuitCoordinator, type ExitDecision } from '../src/main/quit';

function fixture() {
  let dirty: string | undefined;
  const actions = {
    freeze: vi.fn(), drain: vi.fn(async () => {}), silence: vi.fn(async () => {}), prepare: vi.fn(async () => {}),
    retry: vi.fn(async () => {}), unsaved: () => dirty, decide: vi.fn(async (): Promise<ExitDecision> => 'cancel'),
    resume: vi.fn(), finish: vi.fn(async () => {}), failed: vi.fn(),
  };
  return { actions, setDirty: (value?: string) => { dirty = value; }, quit: new QuitCoordinator(actions) };
}
describe('normal application exit', () => {
  it('silences while accepted commands drain and coalesces repeated close requests without losing saves', async () => {
    const { actions, quit } = fixture();
    let drained!: () => void, saving!: () => void;
    actions.drain.mockImplementation(() => new Promise(resolve => { drained = resolve; }));
    actions.prepare.mockImplementation(() => new Promise(resolve => { saving = resolve; }));
    const first = quit.request();
    expect(quit.request()).toBe(first);
    expect(actions.freeze).toHaveBeenCalledWith(true);
    expect(actions.silence).toHaveBeenCalledOnce();
    expect(actions.prepare).not.toHaveBeenCalled();
    drained(); await vi.waitFor(() => expect(actions.prepare).toHaveBeenCalledOnce());
    expect(actions.finish).not.toHaveBeenCalled();
    saving(); await first;
    expect(actions.finish).toHaveBeenCalledOnce();
    expect(actions.decide).not.toHaveBeenCalled();
  });
  it('retries failed saves, retains edits after cancellation, and allows another close attempt', async () => {
    const { actions, quit, setDirty } = fixture();
    setDirty('Two alignments could not be saved');
    actions.decide.mockResolvedValueOnce('retry').mockResolvedValueOnce('cancel');
    await quit.request();
    expect(actions.retry).toHaveBeenCalledOnce();
    expect(actions.finish).not.toHaveBeenCalled();
    expect(actions.resume).toHaveBeenCalledOnce();
    expect(actions.freeze).toHaveBeenLastCalledWith(false);
    actions.decide.mockResolvedValueOnce('retry');
    actions.retry.mockImplementation(async () => { setDirty(); });
    await quit.request();
    expect(actions.finish).toHaveBeenCalledOnce();
  });
  it('finishes with unsaved edits only after an explicit discard choice', async () => {
    const { actions, quit, setDirty } = fixture();
    setDirty('Select a replay'); actions.decide.mockResolvedValue('discard');
    await quit.request();
    expect(actions.decide).toHaveBeenCalledWith('Select a replay');
    expect(actions.finish).toHaveBeenCalledOnce();
    expect(actions.resume).not.toHaveBeenCalled();
  });
  it('keeps the application open and releases the session after preparation fails', async () => {
    const { actions, quit } = fixture();
    const error = new Error('Library is unavailable'); actions.prepare.mockRejectedValue(error);
    await quit.request();
    expect(actions.finish).not.toHaveBeenCalled();
    expect(actions.failed).toHaveBeenCalledWith(error);
    expect(actions.resume).toHaveBeenCalledOnce();
    expect(actions.freeze).toHaveBeenLastCalledWith(false);
  });
});
