import { z } from 'zod';

export const clockReadingSchema = z.object({ mediaSeconds: z.number().finite().nonnegative(), clockSeconds: z.number().int().min(0).max(21600), confidence: z.number().min(0).max(100) });
export type ClockReading = z.infer<typeof clockReadingSchema>;

export const clockPhaseSchema = z.object({ id: z.string().min(1), convention: z.literal('floor'), apiPhaseSeconds: z.number().finite(), uncertaintySeconds: z.number().finite().nonnegative() });
export const clockTransitionSchema = z.object({ window: z.string(), role: z.enum(['fit', 'holdout']), second: z.number().int().nonnegative(), lastOldSeconds: z.number().finite(), firstNewSeconds: z.number().finite() }).refine(value => value.firstNewSeconds > value.lastOldSeconds);
// Retain previously saved evidence without treating it as new midpoint observations.
const legacyClockEvidenceSchema = z.object({
  algorithmVersion: z.literal(1), policyVersion: z.union([z.literal(1), z.literal(2)]), fitWindows: z.number().int().nonnegative(), holdoutWindows: z.number().int().nonnegative(),
  coverageSeconds: z.number().finite().nonnegative(), readings: z.number().int().nonnegative(), inliers: z.number().int().nonnegative(),
  transitions: z.array(clockTransitionSchema).max(1000), hudOffsetSeconds: z.number().finite(), hudUncertaintySeconds: z.number().finite().nonnegative(), phase: clockPhaseSchema.optional(),
});
export const midpointClockEvidenceSchema = z.object({
  algorithmVersion: z.literal(2), method: z.literal('transition-midpoint'),
  before: clockReadingSchema, after: clockReadingSchema, midpointSeconds: z.number().finite().nonnegative(),
});
export type MidpointClockEvidence = z.infer<typeof midpointClockEvidenceSchema>;
export const clockEvidenceSchema = z.union([legacyClockEvidenceSchema, midpointClockEvidenceSchema]);
export interface ClockView {
  status: 'running' | 'accepted' | 'needs-attention';
  message: string;
  framesRead: number;
  offsetSeconds?: number;
  uncertaintySeconds?: number;
}
