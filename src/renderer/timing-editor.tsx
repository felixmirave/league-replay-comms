import { useState } from 'react';
import type { ProbeSnapshot, UserCommand } from '../shared/protocol';
import type { PreviewView } from '../shared/analysis';
import { RecordingPreview } from './preview';

export function time(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const ms = Math.round(Math.abs(seconds) * 1000);
  return `${seconds < 0 ? '−' : ''}${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}
function timestamp(value: string): number {
  if (!/^(?:\d+:)?\d+(?:\.\d+)?$/.test(value.trim())) throw new Error('Enter minutes:seconds, such as 10:45.500, or a number of seconds.');
  const parts = value.trim().split(':').map(Number);
  if (parts.length === 2 && parts[1]! >= 60) throw new Error('Seconds after the colon must be less than 60.');
  const result = parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]!;
  if (!Number.isFinite(result)) throw new Error('Enter a finite timestamp.');
  return result;
}
interface Props { snapshot: ProbeSnapshot; preview: PreviewView; busy: boolean; command(value: UserCommand): Promise<void> }

export function TimingEditor({ snapshot, preview, busy, command }: Props) {
  const saved = snapshot.library?.alignment;
  const [method, setMethod] = useState<'paused' | 'timestamps' | 'offset'>(saved ? 'offset' : snapshot.replay && !snapshot.connectionError ? 'paused' : 'timestamps');
  const [base, setBase] = useState(String(saved?.baseOffsetSeconds ?? snapshot.workflow?.suggestedOffsetSeconds ?? 0));
  const [correction, setCorrection] = useState(saved?.correctionSeconds ?? 0);
  const [fine, setFine] = useState(false);
  const [gameTime, setGameTime] = useState(snapshot.replay ? time(snapshot.replay.timeSeconds) : '');
  const [recordingTime, setRecordingTime] = useState(time(snapshot.positionSeconds ?? 0));
  const [seek, setSeek] = useState('');
  const [error, setError] = useState('');
  const connected = !!snapshot.replay && !snapshot.connectionError;
  const media = snapshot.media!;
  const changeMethod = (value: typeof method) => { setMethod(value); setCorrection(0); setError(''); };
  const submit = async () => {
    setError('');
    try {
      if (method === 'paused') {
        if (!connected || !snapshot.replay?.paused || !snapshot.paused) throw new Error('Pause both the replay in League and the recording at the same moment, or enter the game time instead.');
        await command({ type: 'align-here' });
      } else {
        const offsetSeconds = method === 'offset' ? (base.trim() ? Number(base) : NaN) : timestamp(recordingTime) - timestamp(gameTime);
        if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds + correction) > 86400) throw new Error('Enter valid timing within 24 hours of the replay.');
        await command({ type: 'align', offsetSeconds, correctionSeconds: correction });
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const seekTo = async () => {
    try { setError(''); await command({ type: 'seek-preview', positionSeconds: timestamp(seek) }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="timing-editor">
    {snapshot.library?.clock?.status === 'needs-attention' && <p className="notice" role="status">Automatic clock detection failed. Match a moment manually below to align the comms.</p>}
    {snapshot.library?.alignmentConflict && <p className="notice">Different timing settings were saved for this recording in an older version. Set the correct timing here; the original records are preserved.</p>}
    <div className="clocks"><div><span>Replay in League</span><strong>{connected ? time(snapshot.replay?.timeSeconds) : 'Disconnected'}</strong></div><div><span>Recording</span><strong>{time(snapshot.positionSeconds)}</strong></div></div>
    <div className="row"><button disabled={busy} onClick={() => void command({ type: 'preview', paused: !snapshot.paused })}>{snapshot.paused ? 'Preview recording' : 'Pause recording'}</button><label>Go to recording time<input value={seek} placeholder="10:45.500" onChange={event => setSeek(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void seekTo(); }} /></label><button disabled={busy} onClick={() => void seekTo()}>Go</button></div>
    {method === 'offset' && connected && <button disabled={busy || !snapshot.replay?.paused || !Number.isFinite(Number(base)) || snapshot.replay.timeSeconds + Number(base) + correction < 0 || snapshot.replay.timeSeconds + Number(base) + correction > media.durationSeconds} onClick={() => void command({ type: 'seek-preview', positionSeconds: snapshot.replay!.timeSeconds + Number(base) + correction })}>Preview the matching replay moment</button>}
    <RecordingPreview preview={preview} media={media} position={snapshot.positionSeconds} disabled={busy} command={command} />
    {method === 'timestamps' && <div className="row timestamp-entry"><label>Game time at this moment<input value={gameTime} aria-invalid={!!error} onChange={event => setGameTime(event.target.value)} placeholder="10:00.000" /></label><label>Recording time<input value={recordingTime} aria-invalid={!!error} onChange={event => setRecordingTime(event.target.value)} /></label><button className="text-button" onClick={() => setRecordingTime(time(snapshot.positionSeconds ?? 0))}>Use recording playhead</button></div>}
    {method === 'paused' && <p>Pause League at a recognizable moment, then pause this recording at the same moment.</p>}
    {method !== 'paused' && <div className="correction"><div className="row"><button disabled={busy} onClick={() => setCorrection(value => Math.round((value + (fine ? .01 : .1)) * 1000) / 1000)}>Comms earlier</button><button disabled={busy} onClick={() => setCorrection(value => Math.round((value - (fine ? .01 : .1)) * 1000) / 1000)}>Comms later</button><label className="checkbox"><input type="checkbox" checked={fine} onChange={event => setFine(event.target.checked)} />Fine adjustment (10 ms)</label></div><p>{correction ? `${Math.abs(correction * 1000).toFixed(0)} ms ${correction > 0 ? 'earlier' : 'later'}` : 'No timing correction'}</p></div>}
    {method === 'paused' && <button className="text-button" onClick={() => changeMethod('timestamps')}>Enter game time instead</button>}
    {method !== 'paused' && connected && <button className="text-button" onClick={() => changeMethod('paused')}>Match the paused playheads instead</button>}
    <details><summary>More timing options</summary><label>Offset in seconds<input type="number" step="0.01" value={base} onChange={event => { setBase(event.target.value); setMethod('offset'); }} /></label><p>Recording time minus game time. Changes stay in this draft until saved.</p>{method !== 'timestamps' && <button onClick={() => changeMethod('timestamps')}>Enter both timestamps</button>}{media.probe?.streams.some(stream => stream.type === 'video') && <button onClick={() => void command({ type: 'analyze-clock' })}>Read game clock again</button>}</details>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions"><button className="primary" disabled={busy} onClick={() => void submit()}>{saved ? 'Save timing' : 'Use this moment'}</button>{saved && <button className="text-button" onClick={() => void command({ type: 'workflow', action: 'cancel-edit' })}>Cancel changes</button>}</div>
  </div>;
}
