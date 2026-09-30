import { describe, expect, it } from 'vitest';
import { fitClock, parseClock, type ClockReading } from '../src/analysis/clock-fit';
import { clockEvidenceSchema } from '../src/shared/clock';

const pair = (media = 65.03, second = 60): ClockReading[] => [
  { mediaSeconds: media, clockSeconds: second - 1, confidence: 90 },
  { mediaSeconds: media + 0.01, clockSeconds: second, confidence: 90 },
];
describe('one clock transition', () => {
  it('parses only complete plausible clocks, including minute/hour rollovers', () => {
    expect(parseClock(' 0 : 59 ')).toBe(59);
    expect(parseClock('1:00')).toBe(60);
    expect(parseClock('60:00')).toBe(3600);
    for (const text of ['1234', '12:60', '1:2', 'O:35', 'score 12:34', '12:34 1:00', '999:59']) expect(parseClock(text)).toBeUndefined();
  });
  it('maps the midpoint in the user example directly to the new second', () => {
    const result = fitClock(pair());
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('Expected midpoint');
    expect(result.offsetSeconds).toBeCloseTo(5.035, 8);
    expect(result.evidence.midpointSeconds).toBeCloseTo(65.035, 8);
    expect(result.uncertaintySeconds).toBeCloseTo(0.005, 8);
    expect(clockEvidenceSchema.parse(result.evidence)).toEqual(result.evidence);
  });
  it('accepts negative offsets for partial recordings, with no phase profile or minimum coverage', () => {
    const result = fitClock(pair(0.1, 3600));
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') expect(result.offsetSeconds).toBeCloseTo(-3599.895);
  });
  it('does not impose a transition-gap or uncertainty limit', () => {
    const readings = pair(); readings[1]!.mediaSeconds = 65.4;
    const result = fitClock(readings);
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') expect(result.offsetSeconds).toBeCloseTo(5.215, 8);
  });
  it('requires two readable ordered frames with a one-second clock change', () => {
    expect(fitClock([]).status).toBe('needs-attention');
    expect(fitClock(pair().slice(0, 1)).status).toBe('needs-attention');
    for (const change of [{ confidence: 10 }, { clockSeconds: 59 }, { clockSeconds: 61 }, { mediaSeconds: 65.03 }, { mediaSeconds: NaN }]) {
      const readings = pair(); Object.assign(readings[1]!, change);
      expect(fitClock(readings).status).toBe('needs-attention');
    }
  });
  it('still reads saved legacy evidence without applying it as a new midpoint', () => {
    expect(clockEvidenceSchema.safeParse({ algorithmVersion: 1, policyVersion: 2, fitWindows: 3, holdoutWindows: 1,
      coverageSeconds: 300, readings: 40, inliers: 40, transitions: [], hudOffsetSeconds: 12, hudUncertaintySeconds: 0.02 }).success).toBe(true);
  });
});
