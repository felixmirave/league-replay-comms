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
