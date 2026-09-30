import { z } from 'zod';

export const mediaStreamSchema = z.object({
  index: z.number().int().nonnegative(), type: z.enum(['audio', 'video']), codec: z.string(),
  title: z.string().optional(), language: z.string().optional(),
  startPtsSeconds: z.number().finite().optional(), durationSeconds: z.number().finite().positive().optional(),
  taggedEndPtsSeconds: z.number().finite().optional(),
  packetRange: z.object({ startPtsSeconds: z.number().finite(), endPtsSeconds: z.number().finite() }).optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  sampleRate: z.number().int().positive().optional(), channels: z.number().int().positive().optional(),
});
export const probeSchema = z.object({
  formats: z.array(z.string()), startPtsSeconds: z.number().finite().optional(), durationSeconds: z.number().finite().positive().optional(),
  streams: z.array(mediaStreamSchema).max(256),
});
export type MediaProbe = z.infer<typeof probeSchema>;
export type MediaStream = z.infer<typeof mediaStreamSchema>;
export interface TrackRange { startSeconds: number; endSeconds: number; evidence: 'stream-duration' | 'matroska-tag' | 'packet-scan' }
export const timelineVersion = 1;

/** mpv's demuxer origin is authoritative; ffprobe's format start is not equivalent. */
export function streamRange(stream: MediaStream, probe: MediaProbe, originSeconds: number): TrackRange | undefined {
  const startPts = stream.packetRange?.startPtsSeconds ?? stream.startPtsSeconds ?? (probe.formats.includes('wav') ? 0 : undefined);
  if (startPts === undefined || !Number.isFinite(originSeconds)) return;
  let endPts: number | undefined;
  let evidence: TrackRange['evidence'] = 'stream-duration';
  if (stream.packetRange) { endPts = stream.packetRange.endPtsSeconds; evidence = 'packet-scan'; }
  else if (stream.durationSeconds !== undefined) endPts = startPts + stream.durationSeconds;
  else if (stream.taggedEndPtsSeconds !== undefined) { endPts = stream.taggedEndPtsSeconds; evidence = 'matroska-tag'; }
  if (endPts === undefined) return;
  const startSeconds = Math.max(0, startPts - originSeconds), endSeconds = endPts - originSeconds;
  if (endSeconds <= startSeconds) return;
  return { startSeconds, endSeconds, evidence };
}
export function frameMediaTime(ptsSeconds: number, originSeconds: number): number {
  if (![ptsSeconds, originSeconds].every(Number.isFinite)) throw new Error('Frame timestamp or media origin is unavailable');
  return ptsSeconds - originSeconds;
}
