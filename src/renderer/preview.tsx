import { useEffect, useMemo, useRef, useState } from 'react';
import type { Crop, PreviewView } from '../shared/analysis';
import type { OpenMedia, UserCommand } from '../shared/protocol';

function time(value: number): string { const ms = Math.round(Math.max(0, value) * 1000); return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`; }
interface Props { preview: PreviewView; media: OpenMedia; position?: number; disabled: boolean; mode: 'manual' | 'crop'; command(value: UserCommand): Promise<void>; useFrame(position: number): void }

export function RecordingPreview({ preview, media, position, disabled, mode, command, useFrame }: Props) {
  const waveform = preview.waveform;
  const canvas = useRef<HTMLCanvasElement>(null);
  const cropCanvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const [draftCrop, setDraftCrop] = useState<Crop>();
  const [framePosition, setFramePosition] = useState('0');
  useEffect(() => { if (preview.frame) setFramePosition(preview.frame.positionSeconds.toFixed(3)); }, [preview.frame?.positionSeconds, preview.mediaGeneration]);
  useEffect(() => { setDraftCrop(undefined); drag.current = undefined; }, [preview.mediaGeneration, preview.crop]);
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
  useEffect(() => {
    const canvas = cropCanvas.current, frame = preview.frame;
    const context = canvas?.getContext('2d');
    if (!context || !canvas || !frame) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const crop = draftCrop ?? preview.crop;
    if (!crop) return;
    const x = crop.x * canvas.width, y = crop.y * canvas.height, width = crop.width * canvas.width, height = crop.height * canvas.height;
    context.fillStyle = 'rgba(0,0,0,.45)'; context.fillRect(0, 0, canvas.width, canvas.height); context.clearRect(x, y, width, height);
    context.strokeStyle = '#2864c8'; context.lineWidth = 2; context.strokeRect(x, y, width, height);
  }, [preview.frame, preview.crop, draftCrop]);
  const seek = (value: number) => { if (!disabled) void command({ type: 'seek-preview', positionSeconds: Math.max(0, Math.min(media.durationSeconds - 0.001, value)) }); };
  const windowAround = (center: number, width = 30) => {
    const start = Math.max(0, Math.min(center - width / 2, media.durationSeconds - width));
    void command({ type: 'waveform-window', startSeconds: start, endSeconds: Math.min(media.durationSeconds, start + width) });
  };
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const cropAt = (end: { x: number; y: number }): Crop | undefined => {
    if (!drag.current) return;
    return { x: Math.min(drag.current.x, end.x), y: Math.min(drag.current.y, end.y), width: Math.abs(end.x - drag.current.x), height: Math.abs(end.y - drag.current.y) };
  };
  const videos = media.probe?.streams.filter(stream => stream.type === 'video') ?? [];
  return <div className="recording-preview">
    <div className="section-title"><h3>Audio waveform</h3><span className="muted">{waveform?.complete ? 'Click or use arrow keys to seek' : waveform ? `Analyzed through ${time(waveform.processedSeconds)}` : 'Preparing…'}</span></div>
    {preview.waveformError && <p className="notice" role="status">{preview.waveformError}</p>}
    <canvas ref={canvas} width="1200" height="140" className="waveform" aria-label="Audio waveform" role="slider" aria-valuemin={waveform?.startSeconds ?? 0} aria-valuemax={waveform?.endSeconds ?? media.durationSeconds} aria-valuenow={position ?? 0} aria-valuetext={time(position ?? 0)} tabIndex={disabled ? -1 : 0}
      onClick={event => { if (!waveform) return; const rect = event.currentTarget.getBoundingClientRect(); seek(waveform.startSeconds + (event.clientX - rect.left) / rect.width * (waveform.endSeconds - waveform.startSeconds)); }}
      onKeyDown={event => { if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); seek(event.key === 'Home' ? 0 : media.durationSeconds - .001); } if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek((position ?? waveform?.startSeconds ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.01)); } }} />
    {waveform && <div className="waveform-times"><span>{time(waveform.startSeconds)}</span><span>{time(waveform.endSeconds)}</span></div>}
    <details><summary>Waveform zoom</summary><div className="row compact"><button disabled={disabled} onClick={() => void command({ type: 'waveform-window', startSeconds: 0, endSeconds: media.durationSeconds })}>Whole recording</button><button disabled={disabled} onClick={() => windowAround(position ?? 0)}>Zoom around playhead</button><button disabled={disabled || !waveform} onClick={() => windowAround((waveform?.startSeconds ?? 0) - 15)}>Previous 30 s</button><button disabled={disabled || !waveform} onClick={() => windowAround((waveform?.endSeconds ?? 0) + 15)}>Next 30 s</button></div></details>
    {!!videos.length && <div className="video-preview">
      <div className="section-title"><h3>Video frame</h3>{videos.length > 1 && <label>Video stream<select aria-label="Video stream" value={preview.videoStreamIndex} disabled={disabled} onChange={event => void command({ type: 'preview-video', streamIndex: Number(event.target.value) })}>{videos.map(video => <option key={video.index} value={video.index}>{video.title ?? `Video ${video.index + 1}`}</option>)}</select></label>}</div>
      <div className="row compact"><label>Frame time (seconds)<input type="number" min="0" step="0.01" value={framePosition} onChange={event => setFramePosition(event.target.value)} /></label><button disabled={disabled || !framePosition.trim()} onClick={() => void command({ type: 'preview-frame', positionSeconds: Number(framePosition) })}>Show frame</button><button disabled={disabled || position === undefined} onClick={() => void command({ type: 'preview-frame', positionSeconds: position! })}>Show audio playhead</button>{preview.frameBusy && <span role="status" className="muted">Reading frame…</span>}</div>
      {preview.frameError && <p className="notice" role="status">{preview.frameError}</p>}
      {preview.frame && <>
        <div className="frame-stage"><img src={preview.frame.dataUrl} alt={`Recording frame at ${time(preview.frame.positionSeconds)}`} draggable={false} />{mode === 'crop' && <canvas className="crop-surface" ref={cropCanvas} width={preview.frame.width} height={preview.frame.height} aria-label="Clock region selector"
          onPointerDown={event => { if (disabled) return; drag.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { const crop = cropAt(point(event)); if (crop) setDraftCrop(crop); }}
          onPointerUp={event => { const crop = cropAt(point(event)); drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); if (crop && crop.width * preview.frame!.width >= 4 && crop.height * preview.frame!.height >= 4) void command({ type: 'preview-crop', crop }); else setDraftCrop(undefined); }}
          onPointerCancel={() => { drag.current = undefined; setDraftCrop(undefined); }} />}</div>
        <div className="row compact"><span className="muted">Frame at {time(preview.frame.positionSeconds)}</span>{mode === 'manual' && <button disabled={disabled} onClick={() => useFrame(preview.frame!.positionSeconds)}>Use frame as recording timestamp</button>}{preview.crop && <button disabled={disabled} onClick={() => void command({ type: 'preview-crop' })}>Clear clock region</button>}</div>
        {mode === 'crop' && <><p>Drag around the clock, or enter its area below using the keyboard.</p><fieldset className="crop-inputs"><legend>Clock area (% of frame)</legend>{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{({ x: 'Left', y: 'Top', width: 'Width', height: 'Height' })[key]}<input aria-label={`Clock area ${key}`} type="number" min="0" max="100" step="0.1" value={Math.round((preview.crop?.[key] ?? ({ x: 0, y: 0, width: 1, height: 1 })[key]) * 1000) / 10} disabled={disabled} onChange={event => {
          const value = Number(event.target.value) / 100;
          if (!Number.isFinite(value) || value < 0 || value > 1) return;
          const crop = { ...(preview.crop ?? { x: 0, y: 0, width: 1, height: 1 }), [key]: value };
          crop.width = Math.min(crop.width, 1 - crop.x); crop.height = Math.min(crop.height, 1 - crop.y);
          if (crop.width > 0 && crop.height > 0) void command({ type: 'preview-crop', crop });
        }} /></label>)}</fieldset></>}
      </>}

    </div>}
  </div>;
}
