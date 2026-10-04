import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixturePcm, analyzePcm, verifyCodedAudio, verifySilence, matchRecording } from './audio-verification.ts';

test('audio oracle identifies source position and rejects wrong track, timing and silence', () => {
  const pcm = fixturePcm(1, 4).subarray(48000 * 2, 48000 * 2 * 3);
  const frames = analyzePcm(pcm, 10);
  verifyCodedAudio(frames, at => at - 9, 1, 0.15);
  assert.throws(() => verifyCodedAudio(frames, at => at - 9, 2));
  assert.throws(() => verifyCodedAudio(frames, at => at - 8.5, 1));
  assert.throws(() => verifyCodedAudio(frames, at => at - 9, 1, 0));
  assert.throws(() => verifySilence(frames));
  const silent = analyzePcm(Buffer.alloc(pcm.length)); verifySilence(silent);
  assert.throws(() => verifyCodedAudio(silent, at => at, 1));
});
test('real-recording correlation checks samples independently of playback reports', () => {
  // Nonperiodic deterministic noise avoids ambiguous sine-wave correlations.
  const pcm = Buffer.alloc(48000 * 2 * 4);
  let seed = 123;
  for (let i = 0; i < pcm.length / 2; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pcm.writeInt16LE((seed % 12000) - 6000, i * 2); }
  const captured = Buffer.from(pcm.subarray(48000 * 2, 48000 * 2 * 2));
  for (let i = 0; i < captured.length / 2; i++) captured.writeInt16LE(Math.round(captured.readInt16LE(i * 2) * 0.5), i * 2);
  const result = matchRecording(captured, pcm, 20);
  assert(result.correlation > 0.99);
  assert(Math.abs(result.sourceSeconds - result.capturedSeconds - 21) < 0.001);
  assert.throws(() => matchRecording(Buffer.alloc(captured.length), pcm, 0));
});

test('audio oracle decodes adjacent-code transitions without accepting off-grid tones', () => {
  const fixture = fixturePcm(2, 12);
  // This 2048-sample window is centered on the 11992 -> 12016 Hz transition.
  const start = Math.round(10.5 * 48000) - 1024;
  const frame = analyzePcm(fixture.subarray(start * 2, (start + 2048) * 2))[0]!;
  assert.equal(frame.track, 2);
  assert.equal(frame.sourceSeconds, 10.5);
  assert(Math.abs(frame.frequency! - 12004) < 2, 'The full-window peak lies between the two valid codes');

  const invalid = Buffer.alloc(48000 * 2);
  for (let i = 0; i < 48000; i++) invalid.writeInt16LE(Math.round(7000 * Math.sin(2 * Math.PI * 12004 * i / 48000)), i * 2);
  const frames = analyzePcm(invalid);
  assert(frames.every(frame => frame.sourceSeconds === undefined), 'A steady off-grid tone must remain undecodable');
  assert.throws(() => verifyCodedAudio(frames, () => 10.5, 2));
});

test('audio oracle handles transition window offsets and still rejects wrong timing and track', () => {
  const fixture = fixturePcm(2, 12);
  for (const offset of [0, 1, 144, 479, 959]) {
    const start = 10 * 48000 + offset;
    const frames = analyzePcm(fixture.subarray(start * 2, (start + 48000) * 2));
    verifyCodedAudio(frames, at => 10 + offset / 48000 + at, 2, .15);
    assert.throws(() => verifyCodedAudio(frames, at => 10.5 + offset / 48000 + at, 2, .15));
    assert.throws(() => verifyCodedAudio(frames, at => 10 + offset / 48000 + at, 1, .15));
  }
});
