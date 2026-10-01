import { z } from 'zod';
import { fileVersionSchema } from '../library/model';
import { cropSchema } from './geometry';

export const frameRequestSchema = z.object({ path: z.string(), version: fileVersionSchema, streamIndex: z.number().int().nonnegative(), originSeconds: z.number().finite(), positionSeconds: z.number().finite().nonnegative(), after: z.boolean().optional(), crop: cropSchema });
export type FrameRequest = z.infer<typeof frameRequestSchema>;
export const frameSchema = z.object({ ptsSeconds: z.number().finite(), positionSeconds: z.number().finite(), width: z.number().int().positive().max(480), height: z.number().int().positive().max(120), png: z.instanceof(Uint8Array).refine(value => value.byteLength >= 24 && value.byteLength <= 1_000_000, 'Invalid decoded clock image size') });
export type DecodedFrame = z.infer<typeof frameSchema>;
