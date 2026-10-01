import { useRef, useState } from 'react';
import type { ProbeSnapshot, UserCommand } from '../shared/protocol';

export function time(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const ms = Math.round(Math.abs(seconds) * 1000);
  return `${seconds < 0 ? '−' : ''}${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}
function offset(value: string): number | undefined {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return;
  const number = Number(value);
  if (Number.isFinite(number) && Math.abs(number) <= 86400) return number;
}
interface Props { snapshot: ProbeSnapshot; busy: boolean; send(value: UserCommand): Promise<void> }

export function TimingEditor({ snapshot, busy, send }: Props) {
  const saved = snapshot.library?.alignment;
  const initial = saved ? saved.baseOffsetSeconds + saved.correctionSeconds : 0;
  // This editor owns the input until Done: replay ticks and older save replies
  // must never replace a newer edit, or an incomplete value such as "-".
  const [value, setValue] = useState(String(initial));
  const draft = useRef(value), revision = useRef(0);
  const applied = useRef<number | undefined>(saved && !snapshot.library?.alignmentConflict && snapshot.library?.clock?.status !== 'needs-attention' ? initial : undefined);
  const latest = useRef(Promise.resolve());
  const [error, setError] = useState('');
  const [acting, setActing] = useState(false);
  const connected = !!snapshot.replay && !snapshot.connectionError;
  const listening = connected && !!snapshot.library?.boundToRuntime && snapshot.sync.state !== 'preview';
  const valid = offset(value) !== undefined;
  const disabled = busy || acting;
  const apply = (number: number) => {
    const current = ++revision.current;
    applied.current = number;
    const result = send({ type: 'align', offsetSeconds: number });
    latest.current = result;
    void result.catch(error => {
      if (current !== revision.current) return;
      applied.current = undefined;
      setError(error instanceof Error ? error.message : String(error));
    });
    return result;
  };
  const change = (text: string) => {
    draft.current = text; setValue(text); setError('');
    const number = offset(text);
    if (number !== undefined) void apply(number);
  };
  const adjust = (direction: number, event: { shiftKey: boolean; altKey: boolean }) => {
    const number = offset(draft.current);
    if (number === undefined) return;
    const step = event.shiftKey ? 1 : event.altKey ? .01 : .1;
    const next = Math.round((number + direction * step) * 1000) / 1000;
    if (Math.abs(next) <= 86400) change(String(next));
  };
  const action = async (command: UserCommand) => {
    setActing(true); setError('');
    try {
      if (command.type !== 'stop') {
        const number = offset(draft.current);
        if (number === undefined) throw new Error('Enter a number of seconds between −86400 and 86400.');
        if (applied.current !== number) await apply(number);
        else await latest.current;
      }
      await send(command);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setActing(false); }
  };
  const status = !connected ? 'Open a replay in League to hear your adjustments.'
    : !listening ? 'Start listening to hear your adjustments.'
    : snapshot.sync.state === 'outside-recording' ? 'Outside the recording. Change the offset or move the replay to a recorded moment.'
    : snapshot.sync.state === 'unsupported-speed' ? 'Choose a supported replay speed in League.'
    : snapshot.replay?.paused ? 'Replay paused. Press play in League to hear your adjustments.'
    : 'Listening — timing changes apply immediately.';
  return <div className="timing-editor">
    {snapshot.library?.clock?.status === 'needs-attention' && <p className="notice">Automatic timing could not be detected. Adjust the offset below.</p>}
    {snapshot.library?.alignmentConflict && <p className="notice">Different timing settings were saved for this recording. Set the correct offset below.</p>}
    <label className="timing-offset">Recording offset (seconds)<input type="text" inputMode="decimal" value={value} disabled={disabled} aria-invalid={!valid} aria-describedby="offset-help" onChange={event => change(event.target.value)} onKeyDown={event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); adjust(event.key === 'ArrowUp' ? 1 : -1, event); }
    }} /></label>
    <p id="offset-help">{valid ? 'Positive moves the recording forward; negative moves it back.' : 'Enter a number of seconds between −86400 and 86400.'}</p>
    <div className="timing-steps">
      <button disabled={disabled || !valid} onClick={event => adjust(-1, event)} title="Move the recording backward against the replay"><span aria-hidden="true">−</span> Back 0.1 s</button>
      <button disabled={disabled || !valid} onClick={event => adjust(1, event)} title="Move the recording forward against the replay"><span aria-hidden="true">+</span> Forward 0.1 s</button>
    </div>
    <p className="muted">Use ↑ / ↓ or the buttons. Hold Shift for 1 s, Alt for 0.01 s. Changes save automatically.</p>
    <p className="timing-status" role="status">{status}</p>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions"><button disabled={disabled || (!listening && (!connected || !valid))} onClick={() => void action({ type: listening ? 'stop' : 'follow' })}>{listening ? 'Stop listening' : 'Start listening'}</button><button className="primary" disabled={disabled || !valid} onClick={() => void action({ type: 'workflow', action: 'finish-edit' })}>Done</button></div>
  </div>;
}
