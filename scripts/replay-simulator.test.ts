import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplayTimeline, replayControlSchema } from './replay-simulator.ts';

test('independent replay clock preserves history through pause, jump, speed and replacement', () => {
  let now = 100;
  const timeline = new ReplayTimeline(() => now);
  timeline.set({ time: 10, paused: false });
  now = 102; assert.equal(timeline.at().time, 12);
  timeline.set({ speed: 2 }); now = 105; assert.equal(timeline.at().time, 18);
  timeline.set({ paused: true }); now = 110; assert.equal(timeline.at().time, 18);
  timeline.set({ time: 3, seeking: true, paused: false }); now = 111; assert.equal(timeline.at().time, 3);
  timeline.set({ seeking: false }); now = 112; assert.equal(timeline.at().time, 5);
  assert.equal(timeline.at(103).time, 14);
  timeline.set({ processID: 2000 }); assert.equal(timeline.at().processID, 2000);
});
test('simulator rejects invalid controls rather than corrupting its clock', () => {
  for (const input of [{ time: -1 }, { speed: Infinity }, { fault: 'typo' }, { surprise: true }, { delayMs: 10001 }]) assert.equal(replayControlSchema.safeParse(input).success, false);
});
