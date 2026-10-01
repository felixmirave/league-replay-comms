import type { z } from 'zod';
import type { timingMeasurementSchema } from './timing-measurements.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { analyzeTiming } from './timing-measurements.ts';

function measurements(): z.infer<typeof timingMeasurementSchema> {
  return { schemaVersion: 1, artifactPath: 'companion.exe', capturePath: 'capture.mkv',
    environment: { windows: 'test Windows', leaguePatch: 'test patch', outputDevice: 'test speaker', connection: 'wired', displayRefreshHz: 60 },
    capture: { kind: 'physical', apparatus: 'Independent shared-clock capture fixture', clock: 'capture PTS', pathBiasSeconds: 0, pathUncertaintySeconds: 0.002, calibrationEvidence: 'Fixture assumes zero bias with 2 ms uncertainty' },
    alignment: { offsetSeconds: 45, uncertaintySeconds: 0.003, evidence: 'Independent test offset' }, durationSeconds: 120,
    segments: [{ id: 'steady', startSeconds: 0, endSeconds: 60, kind: 'steady', rate: 1 }, { id: 'changes', startSeconds: 60, endSeconds: 120, kind: 'transition', rate: 1 }],
    steady: Array.from({ length: 200 }, (_, n) => ({ id: `s${n}`, segment: 'steady', capturedAtSeconds: n / 4, gameSeconds: n / 4, heardMediaSeconds: n / 4 + 45.02, gameUncertaintySeconds: 0.002, mediaUncertaintySeconds: 0.001 })),
    transitions: Array.from({ length: 20 }, (_, n) => ({ id: `p${n}`, segment: 'changes', kind: 'pause', triggeredAtSeconds: 61 + n, responseAtSeconds: 61.1 + n, uncertaintySeconds: 0.005 })),
    observations: { unexpectedHardSeeks: 0, dropouts: 0, notes: 'Generated annotations for analyzer tests' } };
}

test('derives signed/media errors, additive uncertainty, rate conversion and complete time accounting', () => {
  const input = measurements();
  input.capture.pathBiasSeconds = 0.005;
  const report = analyzeTiming(input);
  assert.equal(report.steadyByRate['1']!.assessment, 'within-target');
  assert.equal(report.pause.assessment, 'within-target');
  assert(Math.abs(report.steadyMeasurements[0]!.signedWallErrorSeconds - 0.015) < 1e-10);
  assert(Math.abs(report.steadyMeasurements[0]!.uncertaintySeconds - 0.008) < 1e-10);
  assert.deepEqual(report.durations, { steady: 60, transition: 60, muted: 0, excluded: 0, unclassified: 0 });
  assert.equal(report.evidence.releaseCertified, false);
  input.segments[0]!.rate = 2;
  const faster = analyzeTiming(input);
  assert(Math.abs(faster.steadyMeasurements[0]!.signedWallErrorSeconds - 0.005) < 1e-10);
  assert.equal(faster.steadyByRate['2']!.assessment, 'untested');
  assert.equal(faster.steadyByRate['1']!.count, 0);
});

test('uncertain, insufficient, loopback-only and unclassified evidence cannot pass physical gates', () => {
  const input = measurements();
  input.alignment.uncertaintySeconds = 0.09;
  assert.equal(analyzeTiming(input).steadyByRate['1']!.assessment, 'uncertain');
  input.steady = input.steady.slice(0, 5);
  assert.equal(analyzeTiming(input).steadyByRate['1']!.assessment, 'insufficient-samples');
  input.capture.kind = 'wasapi-loopback';
  assert.equal(analyzeTiming(input).pause.assessment, 'untested');
  input.capture.kind = 'physical'; input.segments[1]!.startSeconds = 60.5;
  const incomplete = analyzeTiming(input);
  assert.equal(incomplete.durations.unclassified, 0.5);
  assert.equal(incomplete.pause.assessment, 'untested');
});

test('keeps missing responses in percentile denominator and measures seek recovery after settling', () => {
  const input = measurements();
  input.transitions[0]!.responseAtSeconds = null;
  let report = analyzeTiming(input);
  assert.equal(report.pause.count, 20); assert.equal(report.pause.missingResponses, 1);
  assert.equal(report.pause.p99Seconds, null); assert.equal(report.pause.maximumSeconds, null);
  assert.equal(report.pause.assessment, 'within-target'); // 19/20 satisfy the p95 gate; the failure remains explicit.
  input.transitions[1]!.responseAtSeconds = null;
  report = analyzeTiming(input);
  assert.equal(report.pause.assessment, 'exceeds-target'); assert.equal(report.pause.p95Seconds, null);
  input.transitions = input.transitions.map(trial => ({ ...trial, kind: 'seek', settledAtSeconds: trial.triggeredAtSeconds + 0.5, responseAtSeconds: trial.triggeredAtSeconds + 0.7 }));
  report = analyzeTiming(input);
  assert.equal(report.seekRecovery.assessment, 'within-target');
  assert(Math.abs(report.seekRecovery.p95Seconds! - 0.2) < 1e-10);
  assert.equal(report.transitionMeasurements[0]!.replaySettlingSeconds, 0.5);
});

test('retains muted/excluded time and fails invalid, duplicated or selectively misplaced observations', () => {
  const duplicated = measurements(); duplicated.transitions[1]!.triggeredAtSeconds = duplicated.transitions[0]!.triggeredAtSeconds;
  assert.throws(() => analyzeTiming(duplicated), /distinct, increasing trigger/);
  const input = measurements();
  input.durationSeconds = 150;
  input.segments.push({ id: 'muted', startSeconds: 120, endSeconds: 140, kind: 'muted', rate: 1 }, { id: 'excluded', startSeconds: 140, endSeconds: 150, kind: 'excluded', rate: 1, reason: 'Calibration slate' });
  const report = analyzeTiming(input);
  assert.equal(report.durations.muted, 20); assert.equal(report.durations.excluded, 10);
  input.steady[1]!.capturedAtSeconds = 0;
  assert.throws(() => analyzeTiming(input), /distinct, increasing/);
  input.steady[1]!.capturedAtSeconds = 0.25; input.steady[1]!.id = 's0';
  assert.throws(() => analyzeTiming(input), /Duplicate/);
  input.steady[1]!.id = 's1'; input.steady[1]!.segment = 'muted';
  assert.throws(() => analyzeTiming(input), /outside its steady/);
  input.steady[1]!.segment = 'steady'; input.segments[1]!.startSeconds = 59;
  assert.throws(() => analyzeTiming(input), /nonoverlapping/);
  input.segments[1]!.startSeconds = 60; delete input.segments.at(-1)!.reason;
  assert.throws(() => analyzeTiming(input), /Excluded time/);
});

test('CLI binds annotations and capture to exact artifact evidence, refuses overwrite and changed artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comms measurements café '));
  try {
    const input = measurements(); input.capture.kind = 'synthetic';
    const artifact = Buffer.from('MZsynthetic artifact for CLI test'), capture = Buffer.from('synthetic capture evidence');
    const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const sha256 = hash(artifact);
    await writeFile(join(directory, input.artifactPath), artifact); await writeFile(join(directory, input.capturePath), capture);
    const payloadFiles = Object.fromEntries(['League Replay Comms.exe', 'resources/app.asar', 'resources/bin/win32-x64/mpv.exe', 'resources/bin/win32-x64/ffmpeg.exe', 'resources/bin/win32-x64/ffprobe.exe', 'resources/notices/THIRD_PARTY_NOTICES.html'].map(path => [path, sha256]));
    await writeFile(join(directory, `${input.artifactPath}.verification.json`), JSON.stringify({ schemaVersion: 1, artifact: input.artifactPath, sha256, bytes: artifact.length, payloadFiles }));
    const source = JSON.stringify(input), inputPath = join(directory, 'annotations.json'), output = join(directory, 'report.json');
    await writeFile(inputPath, source);
    const run = (destination: string) => promisify(execFile)(process.execPath, [resolve('scripts/analyze-timing.ts'), inputPath, destination], { timeout: 30000 });
    await run(output);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.artifact.sha256, sha256);
    assert.equal(report.source.captureSha256, hash(capture)); assert.equal(report.source.annotationsSha256, hash(source));
    assert.equal(report.evidence.captureAndArtifactIntegrityVerified, true); assert.equal(report.evidence.releaseCertified, false);
    assert.equal(report.steadyByRate['1'].assessment, 'untested');
    await assert.rejects(run(output), /EEXIST/);
    await writeFile(join(directory, input.artifactPath), 'changed artifact');
    await assert.rejects(run(join(directory, 'must-not-pass.json')), /changed since verification/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
