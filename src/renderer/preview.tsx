import { useEffect, useMemo, useRef } from 'react';
import type { PreviewView } from '../shared/analysis';
import type { OpenMedia, UserCommand } from '../shared/protocol';

function time(value: number): string { const ms = Math.round(Math.max(0, value) * 1000); return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`; }
interface Props { preview: PreviewView; media: OpenMedia; position?: number; disabled: boolean; command(value: UserCommand): Promise<void> }

export function RecordingPreview({ preview, media, position, disabled, command }: Props) {
  const waveform = preview.waveform;
  const canvas = useRef<HTMLCanvasElement>(null);
  const bars = useMemo(() => {
    const values = Array.from({ length: 1200 }, () => ({ low: 0, high: 0 }));
    if (!waveform) return values;
    const duration = waveform.endSeconds - waveform.startSeconds;
    for (const [start, end, low, high] of waveform.peaks) {
      const first = Math.max(0, Math.floor((start - waveform.startSeconds) / duration * 1200));
      const last = Math.min(1199, Math.ceil((end - waveform.startSeconds) / duration * 1200));
      for (let x = first; x <= last; x++) { values[x]!.low = Math.min(values[x]!.low, low); values[x]!.high = Math.max(values[x]!.high, high); }
    }
    return values;
  }, [waveform]);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, 1200, 140);
    context.strokeStyle = '#344862'; context.beginPath(); context.moveTo(0, 70); context.lineTo(1200, 70); context.stroke();
    context.strokeStyle = '#2864c8'; context.lineWidth = 1;
    context.beginPath(); bars.forEach((value, index) => { context.moveTo(index + 0.5, 70 - value.high * 60); context.lineTo(index + 0.5, 70 - value.low * 60); }); context.stroke();
    if (position !== undefined && waveform && position >= waveform.startSeconds && position <= waveform.endSeconds) {
      const x = (position - waveform.startSeconds) / (waveform.endSeconds - waveform.startSeconds) * 1200;
      context.strokeStyle = '#ffda8b'; context.lineWidth = 2; context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 140); context.stroke();
    }
  }, [bars, position, waveform]);
  const seek = (value: number) => { if (!disabled) void command({ type: 'seek-preview', positionSeconds: Math.max(0, Math.min(media.durationSeconds - 0.001, value)) }); };
  const windowAround = (center: number, width = 30) => {
    const start = Math.max(0, Math.min(center - width / 2, media.durationSeconds - width));
    void command({ type: 'waveform-window', startSeconds: start, endSeconds: Math.min(media.durationSeconds, start + width) });
  };
  return <div className="recording-preview">
    <div className="section-title"><h3>Audio waveform</h3><span className="muted">{waveform?.complete ? 'Click or use arrow keys to seek' : waveform ? `Analyzed through ${time(waveform.processedSeconds)}` : 'Preparing…'}</span></div>
    {preview.waveformError && <p className="notice" role="status">{preview.waveformError}</p>}
    <canvas ref={canvas} width="1200" height="140" className="waveform" aria-label="Audio waveform" role="slider" aria-valuemin={waveform?.startSeconds ?? 0} aria-valuemax={waveform?.endSeconds ?? media.durationSeconds} aria-valuenow={position ?? 0} aria-valuetext={time(position ?? 0)} tabIndex={disabled ? -1 : 0}
      onClick={event => { if (!waveform) return; const rect = event.currentTarget.getBoundingClientRect(); seek(waveform.startSeconds + (event.clientX - rect.left) / rect.width * (waveform.endSeconds - waveform.startSeconds)); }}
      onKeyDown={event => { if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); seek(event.key === 'Home' ? 0 : media.durationSeconds - .001); } if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek((position ?? waveform?.startSeconds ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.01)); } }} />
    {waveform && <div className="waveform-times"><span>{time(waveform.startSeconds)}</span><span>{time(waveform.endSeconds)}</span></div>}
    <details><summary>Waveform zoom</summary><div className="row compact"><button disabled={disabled} onClick={() => void command({ type: 'waveform-window', startSeconds: 0, endSeconds: media.durationSeconds })}>Whole recording</button><button disabled={disabled} onClick={() => windowAround(position ?? 0)}>Zoom around playhead</button><button disabled={disabled || !waveform} onClick={() => windowAround((waveform?.startSeconds ?? 0) - 15)}>Previous 30 s</button><button disabled={disabled || !waveform} onClick={() => windowAround((waveform?.endSeconds ?? 0) + 15)}>Next 30 s</button></div></details>
  </div>;
}
