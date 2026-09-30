import { describe, expect, it } from 'vitest';
import { VideoClockAnalyzer, type VideoClockRequest } from '../src/analysis/video-clock';
import type { PreviewDecoder } from '../src/analysis/decoder-client';
import type { ClockReader } from '../src/analysis/ocr-client';
import type { FrameRequest } from '../src/shared/analysis';

const request: VideoClockRequest = { path: 'match.mkv', version: { size: 10, mtimeNs: '1', ctimeNs: '1', device: '1', inode: '1' },
  streamIndex: 0, originSeconds: 7, startSeconds: 0, endSeconds: 900, crop: { x: 0.9, y: 0, width: 0.1, height: 0.1 } };
// Deliberately irregular PTS, independent of the requested seek position.
const pts = Array.from({ length: 30000 }, (_, i) => i / 30 + (i % 2 ? 0.005 : 0));
function analyzer(map: (position: number, request: FrameRequest) => number | undefined = position => Math.floor(position + 700.321), limits?: { frames: number; milliseconds: number }) {
  const requests: FrameRequest[] = [];
  const decoder: PreviewDecoder = {
    frame: async request => {
      requests.push(request);
      const positionSeconds = pts.find(t => request.after ? t > request.positionSeconds + 1e-9 : t >= request.positionSeconds - 1e-9);
      if (positionSeconds === undefined) throw new Error('No video frame at this position.');
      const second = map(positionSeconds, request);
      return { kind: 'frame', ptsSeconds: positionSeconds + request.originSeconds, positionSeconds, width: 240, height: 90,
        dataUrl: `data:image/png;base64,${Buffer.from(JSON.stringify({ second })).toString('base64')}` };
    }, waveform: async () => { throw new Error('Not used'); },
  };
  const reader: ClockReader = { read: async png => {
    const { second } = JSON.parse(Buffer.from(png).toString());
    return { text: second === undefined ? '' : `${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}`, confidence: 90 };
  } };
  return { service: new VideoClockAnalyzer(decoder, reader, limits), requests };
}

describe('single-transition video alignment', () => {
  it('uses actual consecutive VFR frames and accepts immediately without calibration', async () => {
    const { service, requests } = analyzer(); const progress: number[] = [];
    const result = await service.analyze(request, undefined, value => progress.push(value.framesRead));
    expect(result.fit.status, JSON.stringify(result.fit)).toBe('accepted');
    if (result.fit.status !== 'accepted') throw new Error('Expected midpoint');
    const { before, after, midpointSeconds } = result.fit.evidence;
    expect(pts[pts.indexOf(before.mediaSeconds) + 1]).toBe(after.mediaSeconds);
    expect(result.fit.offsetSeconds).toBe(midpointSeconds - after.clockSeconds);
    expect(Math.abs(result.fit.offsetSeconds + 700.321)).toBeLessThan(result.fit.uncertaintySeconds);
    expect(result.readings).toHaveLength(2);
    expect(requests.at(-1)?.after).toBe(true);
    expect(requests.every(value => value.processing === 'clock')).toBe(true);
    expect(result.framesRead).toBe(requests.length); expect(progress.at(-1)).toBe(requests.length);
    expect(result.framesRead).toBeLessThan(20);
  });
  it.each([0.9, 8, 900])('accepts a %s-second partial recording that starts after game start and ends before game end', async endSeconds => {
    const result = await analyzer().service.analyze({ ...request, endSeconds });
    expect(result.fit.status).toBe('accepted');
    if (result.fit.status === 'accepted') expect(result.fit.offsetSeconds).toBeLessThan(-700);
  });
  it('does not read later footage or reject a later conflicting offset', async () => {
    const { service, requests } = analyzer(position => {
      if (position > 2) throw new Error('Must not check consistency after finding the first tick');
      return Math.floor(position + 700.321);
    });
    expect((await service.analyze(request)).fit.status).toBe('accepted');
    expect(Math.max(...requests.map(value => value.positionSeconds))).toBeLessThan(2);
  });
  it('searches past loading screens and ignores trailing menus', async () => {
    const { service } = analyzer(position => position < 360 || position > 650 ? undefined : Math.floor(position - 345.321));
    const result = await service.analyze(request);
    expect(result.fit.status, JSON.stringify(result.fit)).toBe('accepted');
    if (result.fit.status === 'accepted') expect(Math.abs(result.fit.offsetSeconds - 345.321)).toBeLessThan(result.fit.uncertaintySeconds);
  });
  it('uses the default crop or asks for a manual crop when no tick is readable', async () => {
    const detected = await analyzer((_position, frame) => frame.crop?.x === 0.965 ? Math.floor(_position + 700.321) : undefined).service.analyze({ ...request, crop: undefined });
    expect(detected.fit.status).toBe('accepted'); expect(detected.crop?.x).toBe(0.965);
    const missing = await analyzer(() => undefined).service.analyze(request);
    expect(missing.fit.status).toBe('needs-attention');
    expect((await analyzer().service.analyze({ ...request, endSeconds: 0.02 })).fit.status).toBe('needs-attention');
  });
  it('never bridges an unreadable intervening frame as if two samples were consecutive', async () => {
    const result = await analyzer(position => {
      const i = pts.indexOf(position);
      return i % 2 ? undefined : Math.floor(position + 700.321);
    }).service.analyze({ ...request, endSeconds: 3 });
    expect(result.fit.status).toBe('needs-attention');
  });
  it('respects the frame budget and cancellation', async () => {
    await expect(analyzer(undefined, { frames: 2, milliseconds: 5000 }).service.analyze(request)).rejects.toThrow('frame limit');
    const abort = new AbortController(); const { service, requests } = analyzer();
    await expect(service.analyze(request, abort.signal, event => { if (event.framesRead === 2) abort.abort(); })).rejects.toThrow();
    expect(requests.length).toBeLessThanOrEqual(2);
  });
});
