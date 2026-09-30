import { z } from 'zod';

const seconds = z.number().finite().nonnegative();
const text = z.string().trim().min(1).max(2000);
const segment = z.object({ id: text, startSeconds: seconds, endSeconds: seconds,
  kind: z.enum(['steady', 'transition', 'muted', 'excluded']), rate: z.number().finite().positive().max(64), reason: text.optional(),
}).strict().refine(value => value.endSeconds > value.startSeconds, 'Segment must have positive duration')
  .refine(value => value.kind !== 'excluded' || !!value.reason, 'Excluded time needs a reason');
const steady = z.object({ id: text, segment: text, capturedAtSeconds: seconds, gameSeconds: seconds, heardMediaSeconds: seconds,
  gameUncertaintySeconds: seconds, mediaUncertaintySeconds: seconds,
}).strict();
const transition = z.object({ id: text, segment: text, kind: z.enum(['pause', 'speed-change', 'seek']),
  triggeredAtSeconds: seconds, settledAtSeconds: seconds.optional(), responseAtSeconds: seconds.nullable(), uncertaintySeconds: seconds,
}).strict().refine(value => value.kind !== 'seek' || value.settledAtSeconds !== undefined, 'Seek trials need independently observed replay settling')
  .refine(value => value.settledAtSeconds === undefined || value.settledAtSeconds >= value.triggeredAtSeconds, 'Replay cannot settle before the trigger')
  .refine(value => value.responseAtSeconds === null || value.responseAtSeconds >= value.triggeredAtSeconds, 'Response cannot precede the trigger');

/** Operator annotations refer to one continuous capture and a shared capture clock. */
export const timingMeasurementSchema = z.object({
  schemaVersion: z.literal(1), artifactPath: text, capturePath: text,
  environment: z.object({ windows: text, leaguePatch: text, outputDevice: text, connection: text, displayRefreshHz: z.number().finite().positive() }).strict(),
  capture: z.object({ kind: z.enum(['physical', 'wasapi-loopback', 'synthetic']), apparatus: text, clock: text,
    pathBiasSeconds: z.number().finite(), pathUncertaintySeconds: seconds, calibrationEvidence: text,
  }).strict(),
  alignment: z.object({ offsetSeconds: z.number().finite(), uncertaintySeconds: seconds, evidence: text }).strict(),
  durationSeconds: z.number().finite().positive(),
  segments: z.array(segment).min(1).max(10000),
  steady: z.array(steady).max(100000), transitions: z.array(transition).max(10000),
  observations: z.object({ unexpectedHardSeeks: z.number().int().nonnegative(), dropouts: z.number().int().nonnegative(), notes: text }).strict(),
}).strict();

// These are descriptive sample gates. Their counts do not establish a confidence
// interval or a population-level reliability guarantee.
export const timingPolicy = Object.freeze({ version: 1, percentile: 0.95, minimumSteadySamples: 200, minimumTransitionTrials: 20,
  steadySeconds: 0.1, pauseSeconds: 0.15, speedChangeSeconds: 0.15, seekSeconds: 0.35 });

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const value = sorted[Math.ceil(sorted.length * fraction) - 1];
  return Number.isFinite(value) ? value : null;
};
const maximum = values => values.length ? percentile(values, 1) : null;

function summarize(values, targetSeconds, minimumSamples, eligible) {
  const lower = values.map(value => value.lower), upper = values.map(value => value.upper);
  const lower95 = percentile(lower, 0.95), upper95 = percentile(upper, 0.95);
  let assessment = 'untested';
  if (values.length && eligible) {
    if (values.length < minimumSamples) assessment = 'insufficient-samples';
    else if (upper95 !== null && upper95 <= targetSeconds) assessment = 'within-target';
    else if (lower95 === null || lower95 > targetSeconds) assessment = 'exceeds-target';
    else assessment = 'uncertain';
  }
  return { count: values.length, minimumSamples, targetSeconds, assessment,
    p95Seconds: percentile(values.map(value => value.value), 0.95), p99Seconds: percentile(values.map(value => value.value), 0.99),
    maximumSeconds: maximum(values.map(value => value.value)), p95LowerSeconds: lower95, p95UpperSeconds: upper95,
    missingResponses: values.filter(value => !Number.isFinite(value.value)).length,
    definitelyOverTarget: lower.filter(value => value > targetSeconds).length,
    possiblyOverTarget: upper.filter(value => value > targetSeconds).length };
}

/** Derive statistics from raw annotations, never from the app's requested times. */
export function analyzeTiming(input) {
  const data = timingMeasurementSchema.parse(input);
  const segments = new Map(); let end = 0;
  const durations = { steady: 0, transition: 0, muted: 0, excluded: 0, unclassified: 0 };
  for (const item of data.segments) {
    if (segments.has(item.id) || item.startSeconds < end || item.endSeconds > data.durationSeconds) throw new Error('Segments must be unique, chronological, nonoverlapping, and within the capture');
    durations.unclassified += item.startSeconds - end;
    durations[item.kind] += item.endSeconds - item.startSeconds;
    end = item.endSeconds; segments.set(item.id, item);
  }
  durations.unclassified += data.durationSeconds - end;
  const ids = new Set();
  const inSegment = (item, kind, ...times) => {
    if (ids.has(item.id)) throw new Error(`Duplicate observation ID: ${item.id}`);
    ids.add(item.id);
    const section = segments.get(item.segment);
    if (!section || section.kind !== kind || times.some(time => time !== null && time !== undefined && (time < section.startSeconds || time > section.endSeconds))) throw new Error(`Observation ${item.id} is outside its ${kind} segment`);
    return section;
  };
  const groups = new Map(), raw = []; let lastSampleAt = -Infinity;
  for (const item of data.steady) {
    if (item.capturedAtSeconds <= lastSampleAt) throw new Error('Steady observations must have distinct, increasing capture timestamps');
    lastSampleAt = item.capturedAtSeconds;
    const section = inSegment(item, 'steady', item.capturedAtSeconds);
    const mediaErrorSeconds = item.heardMediaSeconds - item.gameSeconds - data.alignment.offsetSeconds;
    const signedWallErrorSeconds = mediaErrorSeconds / section.rate - data.capture.pathBiasSeconds;
    const uncertaintySeconds = (item.gameUncertaintySeconds + item.mediaUncertaintySeconds + data.alignment.uncertaintySeconds) / section.rate + data.capture.pathUncertaintySeconds;
    const value = Math.abs(signedWallErrorSeconds);
    const bound = { value, lower: Math.max(0, value - uncertaintySeconds), upper: value + uncertaintySeconds };
    const key = String(section.rate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bound);
    raw.push({ id: item.id, rate: section.rate, capturedAtSeconds: item.capturedAtSeconds, mediaErrorSeconds, signedWallErrorSeconds, uncertaintySeconds });
  }
  const trials = { pause: [], 'speed-change': [], seek: [] }, transitions = []; let lastTriggerAt = -Infinity;
  for (const item of data.transitions) {
    if (item.triggeredAtSeconds <= lastTriggerAt) throw new Error('Transition trials must have distinct, increasing trigger timestamps');
    lastTriggerAt = item.triggeredAtSeconds;
    inSegment(item, 'transition', item.triggeredAtSeconds, item.settledAtSeconds, item.responseAtSeconds);
    const start = item.kind === 'seek' ? item.settledAtSeconds : item.triggeredAtSeconds;
    // A missing response stays in the percentile denominator as infinity.
    const value = item.responseAtSeconds === null ? Infinity : Math.max(0, item.responseAtSeconds - start);
    trials[item.kind].push({ value, lower: Math.max(0, value - item.uncertaintySeconds), upper: value + item.uncertaintySeconds });
    transitions.push({ id: item.id, kind: item.kind, responseSeconds: Number.isFinite(value) ? value : null,
      replaySettlingSeconds: item.settledAtSeconds === undefined ? null : item.settledAtSeconds - item.triggeredAtSeconds,
      uncertaintySeconds: item.uncertaintySeconds });
  }
  const physical = data.capture.kind === 'physical';
  const completeClassification = durations.unclassified < 1e-6;
  const eligible = physical && completeClassification;
  // Only the 1x audible gate is defined by the plan. Other rates are reported,
  // with both media and wall coordinates, without manufacturing another gate.
  const steadyByRate = Object.fromEntries([...groups].map(([rate, values]) => [rate, summarize(values, timingPolicy.steadySeconds, timingPolicy.minimumSteadySamples, eligible && Number(rate) === 1)]));
  if (!steadyByRate['1']) steadyByRate['1'] = summarize([], timingPolicy.steadySeconds, timingPolicy.minimumSteadySamples, eligible);
  return { schemaVersion: 1, policy: timingPolicy, environment: data.environment, capture: data.capture, alignment: data.alignment,
    evidence: { physicalCaptureDeclared: physical, completeTimeClassification: completeClassification,
      captureAndArtifactIntegrityVerified: false, independentlyReviewed: false, releaseCertified: false },
    durationSeconds: data.durationSeconds, durations, observations: data.observations, steadyByRate,
    pause: summarize(trials.pause, timingPolicy.pauseSeconds, timingPolicy.minimumTransitionTrials, eligible),
    speedChange: summarize(trials['speed-change'], timingPolicy.speedChangeSeconds, timingPolicy.minimumTransitionTrials, eligible),
    seekRecovery: summarize(trials.seek, timingPolicy.seekSeconds, timingPolicy.minimumTransitionTrials, eligible),
    steadyMeasurements: raw, transitionMeasurements: transitions,
    limitations: ['Operator annotations and apparatus calibration need independent review.', 'Sample percentiles do not establish a population reliability bound.',
      'Muted, excluded, and unclassified duration remains visible; passing sample statistics does not certify a release.',
      'Null percentile/max values with missing responses represent unbounded recovery, not zero latency.',
      'Transition uncertainty must include differential capture-path delay; the steady capture bias is not subtracted from transitions.'] };
}
