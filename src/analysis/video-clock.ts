import type { AnalysisDecoder } from './decoder-client';
import type { ClockReader, ClockText } from './ocr-client';
import { experimentalClockPolicy, fitClock, parseClock, type ClockFit, type ClockReading } from './clock-fit';
import type { FrameRequest, DecodedFrame } from '../shared/analysis';
import { gameClockCrop, type Crop } from '../shared/geometry';
import type { FileIdentity } from '../library/model';

// Old cached sparse windows do not establish consecutive-frame evidence.
export const clockAnalysisVersion = 4;

export interface VideoClockRequest extends Omit<FrameRequest, 'kind' | 'positionSeconds' | 'after' | 'crop'> {
  startSeconds: number;
  endSeconds: number;
  hash?: string;
  importId?: string;
  force?: boolean;
}
export interface ClockProgress { stage: 'locating-clock' | 'finding-transition'; framesRead: number }
export interface VideoClockResult { crop?: Crop; fit: ClockFit; readings: ClockReading[]; framesRead: number; fromCache?: boolean }
export interface VideoClockJobs {
  analyze(request: VideoClockRequest, signal?: AbortSignal, progress?: (value: ClockProgress) => void): Promise<VideoClockResult>;
  identify?(importId: string, identity: FileIdentity): Promise<void>;
  flush?(): Promise<void>;
}

export interface ClockFrame extends ClockText { frame: DecodedFrame; crop: Crop; clockSeconds?: number }

/** Locate one tick, decode its adjacent frames, then accept their midpoint. */
export class VideoClockAnalyzer implements VideoClockJobs {
  constructor(private readonly decoder: AnalysisDecoder, private readonly reader: ClockReader,
    private readonly limits = { frames: 300, milliseconds: 180000 }) {}

  /** The same crop, native preprocessing, OCR and acceptance used by video analysis. */
  async readFrame(request: Omit<FrameRequest, 'kind' | 'crop'>, signal?: AbortSignal): Promise<ClockFrame> {
    const crop = gameClockCrop;
    const frame = await this.decoder.frame({ ...request, crop, kind: 'frame' }, signal);
    const text = await this.reader.read(frame.png, signal);
    const clockSeconds = text.confidence >= experimentalClockPolicy.minConfidence ? parseClock(text.text) : undefined;
    return { frame, crop, ...text, clockSeconds };
  }

  async analyze(request: VideoClockRequest, signal?: AbortSignal, progress?: (value: ClockProgress) => void): Promise<VideoClockResult> {
    if (!Number.isFinite(request.startSeconds) || !Number.isFinite(request.endSeconds) || request.startSeconds < 0 || request.endSeconds <= request.startSeconds) throw new Error('Invalid video clock range');
    const crop = gameClockCrop;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('Clock analysis reached its time limit. Match a moment manually to align the comms.')), this.limits.milliseconds);
    const active = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let framesRead = 0;
    try {
      active.throwIfAborted();
      const read = async (positionSeconds: number, stage: ClockProgress['stage'], after = false): Promise<ClockReading | undefined> => {
        active.throwIfAborted();
        if (positionSeconds >= request.endSeconds) return;
        if (framesRead >= this.limits.frames) throw new Error('Clock analysis reached its frame limit. Match a moment manually to align the comms.');
        framesRead++;
        progress?.({ stage, framesRead });
        let decoded: ClockFrame;
        try {
          decoded = await this.readFrame({ path: request.path, version: request.version, streamIndex: request.streamIndex,
            originSeconds: request.originSeconds, positionSeconds, after }, active);
        } catch (error) {
          active.throwIfAborted();
          // A partial recording may end before the requested next frame exists.
          if (error instanceof Error && error.message.startsWith('No video frame at this position.')) return;
          throw error;
        }
        active.throwIfAborted();
        const { frame, clockSeconds, confidence } = decoded;
        if (clockSeconds === undefined || frame.positionSeconds >= request.endSeconds || frame.positionSeconds < request.startSeconds) return;
        return { mediaSeconds: frame.positionSeconds, clockSeconds, confidence };
      };
      const adjacentPair = async (before: ClockReading, after: ClockReading): Promise<ClockReading[] | undefined> => {
        // Narrow the search cheaply. These samples are never used as the anchor.
        while (after.mediaSeconds - before.mediaSeconds > 0.08) {
          const middle = await read((before.mediaSeconds + after.mediaSeconds) / 2, 'finding-transition');
          if (!middle) return;
          if (middle.mediaSeconds <= before.mediaSeconds || middle.mediaSeconds >= after.mediaSeconds) break;
          if (middle.clockSeconds === before.clockSeconds) before = middle;
          else if (middle.clockSeconds === after.clockSeconds) after = middle;
          else return;
        }
        // Strict next-frame decoding establishes adjacency at any frame rate.
        while (before.mediaSeconds < after.mediaSeconds) {
          const next = await read(before.mediaSeconds, 'finding-transition', true);
          if (!next || next.mediaSeconds <= before.mediaSeconds) return;
          if (next.clockSeconds === before.clockSeconds + 1) return [before, next];
          if (next.clockSeconds !== before.clockSeconds) return;
          before = next;
        }
      };
      const length = request.endSeconds - request.startSeconds;
      const windowLength = Math.min(2, length);
      // These are search locations, not consistency/holdout checks. Stop at the first tick.
      const starts = [...new Set([0, 0.12, 0.3, 0.49, 0.68, 0.87, 1, 0.58, 0.4, 0.2, 0.77]
        .map(fraction => request.startSeconds + Math.max(0, length - windowLength) * fraction))];
      for (const start of starts) {
        let previous: ClockReading | undefined;
        const step = Math.min(0.4, windowLength / 8);
        for (let at = 0; at <= Math.ceil(windowLength / step); at++) {
          const current = await read(start + at * step, 'locating-clock');
          if (previous && current && current.mediaSeconds > previous.mediaSeconds && current.clockSeconds === previous.clockSeconds + 1) {
            const readings = await adjacentPair(previous, current);
            if (readings) return { crop, fit: fitClock(readings), readings, framesRead };
          }
          previous = current;
        }
      }
      return { crop, fit: fitClock([]), readings: [], framesRead };
    } finally { clearTimeout(timer); }
  }
}
