import { clockReadingSchema, type ClockReading, type MidpointClockEvidence } from '../shared/clock';
export type { ClockReading } from '../shared/clock';

export const experimentalClockPolicy = { minConfidence: 40 } as const;

export type ClockFit =
  | { status: 'needs-attention'; reason: 'insufficient-evidence'; message: string }
  | { status: 'accepted'; offsetSeconds: number; uncertaintySeconds: number; evidence: MidpointClockEvidence };

/** Strict syntax prevents a missing colon or a neighboring counter becoming a clock. */
export function parseClock(text: string): number | undefined {
  const match = text.trim().match(/^(\d{1,3})\s*:\s*([0-5]\d)$/);
  if (!match) return;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds <= 6 * 3600 ? seconds : undefined;
}

/** The caller supplies two consecutive decoded frames, not sparse seek samples. */
export function fitClock(readings: readonly ClockReading[]): ClockFit {
  const [before, after] = readings;
  if (readings.length !== 2 || !before || !after
    || ![before, after].every(reading => clockReadingSchema.safeParse(reading).success && reading.confidence >= experimentalClockPolicy.minConfidence)
    || after.mediaSeconds <= before.mediaSeconds || after.clockSeconds !== before.clockSeconds + 1) {
    return { status: 'needs-attention', reason: 'insufficient-evidence', message: 'The game clock could not be read. Adjust the recording offset manually.' };
  }
  const midpointSeconds = (before.mediaSeconds + after.mediaSeconds) / 2;
  return {
    status: 'accepted', offsetSeconds: midpointSeconds - after.clockSeconds,
    // Frame sampling resolution only; this is not a measured HUD/API accuracy bound.
    uncertaintySeconds: (after.mediaSeconds - before.mediaSeconds) / 2,
    evidence: { algorithmVersion: 2, method: 'transition-midpoint', before, after, midpointSeconds },
  };
}
