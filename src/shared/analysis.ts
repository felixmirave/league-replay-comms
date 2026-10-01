import { z } from 'zod';
import { fileVersionSchema } from '../library/model';
import { cropSchema } from './geometry';

const source = { path: z.string(), version: fileVersionSchema, streamIndex: z.number().int().nonnegative(), originSeconds: z.number().finite() };
export const frameRequestSchema = z.object({ kind: z.literal('frame'), ...source, positionSeconds: z.number().finite().nonnegative(), after: z.boolean().optional(), crop: cropSchema });
export const waveformRequestSchema = z.object({ kind: z.literal('waveform'), ...source, sampleRate: z.number().int().positive().max(768000), startSeconds: z.number().finite().nonnegative(), endSeconds: z.number().finite().positive(), bucketSeconds: z.number().min(0.005).max(60) }).refine(value => value.endSeconds > value.startSeconds && value.endSeconds - value.startSeconds <= 120 && (value.endSeconds - value.startSeconds) / value.bucketSeconds <= 25000, 'Waveform window is too large');
export const decodeRequestSchema = z.union([frameRequestSchema, waveformRequestSchema]);
export type FrameRequest = z.infer<typeof frameRequestSchema>;
export type WaveformRequest = z.infer<typeof waveformRequestSchema>;
export type DecodeRequest = z.infer<typeof decodeRequestSchema>;
export const frameSchema = z.object({ kind: z.literal('frame'), ptsSeconds: z.number().finite(), positionSeconds: z.number().finite(), width: z.number().int().positive().max(480), height: z.number().int().positive().max(120), png: z.instanceof(Uint8Array).refine(value => value.byteLength >= 24 && value.byteLength <= 1_000_000, 'Invalid decoded clock image size') });
export type DecodedFrame = z.infer<typeof frameSchema>;
export const peakSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1)]);
/** Each bucket contains [start seconds, end seconds, minimum, maximum]. */
export type WaveformPeak = z.infer<typeof peakSchema>;
export const waveformSchema = z.object({ kind: z.literal('waveform'), startSeconds: z.number().finite(), endSeconds: z.number().finite(), bucketSeconds: z.number().positive(), peaks: z.array(peakSchema).max(25001) });
export type WaveformChunk = z.infer<typeof waveformSchema>;
export type DecodeResult = DecodedFrame | WaveformChunk;
export interface PreviewView {
  revision: number;
  mediaGeneration: number;
  waveform?: { peaks: WaveformPeak[]; startSeconds: number; endSeconds: number; complete: boolean; processedSeconds: number };
  waveformError?: string;
}
