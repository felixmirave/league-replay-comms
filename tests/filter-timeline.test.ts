import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
let code: string;
beforeAll(async () => { code = (await transform(await readFile('src/audio/timeline-worklet.ts', 'utf8'), { loader: 'ts', format: 'iife' })).code; });
interface Player { cursor: number; playing: boolean; port: { onmessage: (event: { data: unknown }) => void }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }
function player(frequency = 440) {
  const messages: { type: string; frame: number }[] = [];
  let instance: Player;
  const context = vm.createContext({ Float32Array, Math, Map, sampleRate: 48000, currentFrame: 0,
    AudioWorkletProcessor: class { port = { onmessage: () => {}, postMessage: (data: { type: string; frame: number }) => messages.push(data) }; },
    registerProcessor: (_name: string, Constructor: new () => Player) => { instance = new Constructor(); },
  });
  vm.runInContext(code, context);
  const send = (data: unknown) => instance!.port.onmessage({ data });
  const raw = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * frequency * i / 48000) * 0.2);
  send({ type: 'reset', epoch: 1, frame: 0 });
  send({ type: 'chunk', epoch: 1, start: 0, length: raw.length, raw: [raw, raw] });
  let frame = 0;
  const render = () => {
    context.currentFrame = frame; frame += 128;
    const outputs = [[new Float32Array(128), new Float32Array(128)], [new Float32Array(128), new Float32Array(128)]];
    instance!.process([], outputs); return outputs;
  };
  return { get instance() { return instance!; }, send, render, raw, messages };
}
describe('filter playback timeline', () => {
  it('keeps raw and enhanced samples on the exact source timeline at 1×', () => {
    const reader = player(); reader.send({ type: 'clean-chunk', epoch: 1, start: 0, from: 0, length: 48000, clean: Float32Array.from(reader.raw, value => value * .5) }); reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 48000, rate: 1 });
    for (let block = 0; block < 100; block++) {
      const outputs = reader.render();
      expect(outputs[0]![0]).toEqual(reader.raw.slice(block * 128, (block + 1) * 128));
      for (let i = 0; i < 128; i++) expect(outputs[1]![0]![i]).toBeCloseTo(outputs[0]![0]![i]! * (1 - Math.min(1, (block * 128 + i + 1) / 2400) * .5), 6);
    }
  });
  it.each([0.5, 2])('preserves pitch and path alignment at %s×', rate => {
    const reader = player(); reader.send({ type: 'clean-chunk', epoch: 1, start: 0, from: 0, length: 48000, clean: Float32Array.from(reader.raw, value => value * .5) }); reader.send({ type: 'reference', epoch: 1, clean: true }); reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 48000, rate });
    const samples: number[] = [];
    for (let block = 0; block < 100; block++) {
      const outputs = reader.render(); samples.push(...outputs[0]![0]!);
      for (let i = 0; i < 128; i++) expect(outputs[1]![0]![i]).toBeCloseTo(outputs[0]![0]![i]! * (1 - Math.min(1, (block * 128 + i + 1) / 2400) * .5), 6);
    }
    let crossings = 0;
    for (let i = 480; i < samples.length - 1; i++) if (samples[i]! <= 0 && samples[i + 1]! > 0) crossings++;
    expect(crossings / ((samples.length - 480) / 48000)).toBeGreaterThan(430);
    expect(crossings / ((samples.length - 480) / 48000)).toBeLessThan(450);
    expect(reader.instance.cursor).toBeCloseTo(12800 * rate);
  });
  it.each([.98, 1.02])('does not double cleaned speech transients during %s× correction', rate => {
    const reader = player();
    let seed = 19;
    const noisy = Float32Array.from({ length: 48000 }, () => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return (seed / 4294967296 * 2 - 1) * .5;
    });
    const clean = new Float32Array(48000);
    for (let frame = 2400; frame < 42000; frame += 4800) clean[frame] = 1;
    reader.send({ type: 'chunk', epoch: 1, start: 0, length: 48000, raw: [noisy, noisy] });
    reader.send({ type: 'clean-chunk', epoch: 1, start: 0, from: 0, length: 48000, clean });
    reader.send({ type: 'reference', epoch: 1, clean: true });
    reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 42000, rate });
    for (let block = 0; block < 20; block++) reader.render();
    reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 42000, rate });
    const samples: number[] = [];
    for (let block = 0; block < 340; block++) samples.push(...reader.render()[1]![0]!);
    let groups = 0, previous = -Infinity;
    for (let frame = 0; frame < samples.length; frame++) {
      if (samples[frame]! <= .05) continue;
      if (frame - previous > 48) groups++;
      previous = frame;
    }
    expect(groups).toBe(9);
  });
  it('freezes on underflow and ignores stale prepared audio after a seek', () => {
    const reader = player(); reader.send({ type: 'reset', epoch: 2, frame: 49000 });
    reader.send({ type: 'chunk', epoch: 1, start: 48000, length: 48000, raw: [reader.raw, reader.raw] });
    reader.send({ type: 'play', epoch: 2, frame: 49000, when: 0, end: 96000 }); reader.render();
    expect(reader.instance.playing).toBe(false); expect(reader.instance.cursor).toBe(49000);
    expect(reader.messages.at(-1)).toMatchObject({ type: 'buffering', frame: 49000 });
  });
});

it('plays original stereo immediately while suppression is unavailable', () => {
  const reader = player();
  const right = Float32Array.from(reader.raw, value => -value || 0);
  reader.send({ type: 'chunk', epoch: 1, start: 0, length: 48000, raw: [reader.raw, right] });
  reader.send({ type: 'reference', epoch: 1, clean: true });
  reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 48000, rate: 1 });
  const outputs = reader.render();
  expect(outputs[1]![0]).toEqual(reader.raw.slice(0, 128));
  expect(outputs[1]![1]).toEqual(right.slice(0, 128));
  expect(reader.instance.playing).toBe(true);
});

it('fades into independently arriving suppression without moving the source cursor', () => {
  const reader = player();
  reader.send({ type: 'chunk', epoch: 1, start: 0, length: 48000, raw: [reader.raw, reader.raw] });
  reader.send({ type: 'reference', epoch: 1, clean: true });
  reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 48000, rate: 1 });
  for (let block = 0; block < 10; block++) reader.render();
  reader.send({ type: 'clean-chunk', epoch: 1, start: 0, from: 1280, length: 48000, clean: Float32Array.from(reader.raw, value => value * .5) });
  for (let block = 0; block < 25; block++) {
    const before = reader.instance.cursor;
    const outputs = reader.render();
    expect(reader.instance.cursor).toBe(before + 128);
    for (let i = 0; i < 128; i++) {
      const weight = Math.min(1, (block * 128 + i + 1) / 2400);
      expect(outputs[1]![0]![i]).toBeCloseTo(reader.raw[before + i]! * (1 - weight * .5), 6);
    }
  }
  expect(reader.instance.playing).toBe(true);
  expect(reader.messages.filter(message => message.type === 'buffering')).toEqual([]);
});

it('keeps playing when a partial clean chunk runs out and rejects patches from an old seek', () => {
  const reader = player();
  reader.send({ type: 'chunk', epoch: 1, start: 0, length: 48000, raw: [reader.raw, reader.raw] });
  reader.send({ type: 'clean-chunk', epoch: 1, start: 0, from: 0, length: 50, clean: new Float32Array(50) });
  reader.send({ type: 'clean-chunk', epoch: 0, start: 0, from: 0, length: 48000, clean: new Float32Array(48000) });
  reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 48000, rate: 1 });
  reader.render();
  const outputs = reader.render();
  expect(outputs[1]![0]).toEqual(reader.raw.slice(128, 256));
  expect(reader.instance.playing).toBe(true);
  expect(reader.instance.cursor).toBe(256);
});

it.each([false, true])('keeps audio finite when a speed correction returns to 1× (suppression %s)', noise => {
  const reader = player();
  reader.send({ type: 'chunk', epoch: 1, start: 0, length: 48000, raw: [reader.raw, reader.raw] });
  if (noise) reader.send({ type: 'clean-chunk', epoch: 1, start: 0, from: 0, length: 48000, clean: Float32Array.from(reader.raw, value => value * .5) });
  reader.send({ type: 'reference', epoch: 1, clean: noise });
  reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 48000, rate: 1.02 });
  for (let block = 0; block < 20; block++) reader.render();
  expect(Number.isInteger(reader.instance.cursor)).toBe(false);
  const frame = Math.floor(reader.instance.cursor);
  reader.send({ type: 'rate', epoch: 1, rate: 1 });
  const outputs = reader.render();
  for (const output of outputs) for (const channel of output) expect(channel.every(Number.isFinite)).toBe(true);
  expect(outputs[0]![0]).toEqual(reader.raw.slice(frame, frame + 128));
  for (let i = 0; i < 128; i++) expect(outputs[1]![0]![i]).toBeCloseTo(outputs[0]![0]![i]! * (noise ? .5 : 1), 6);
});

it.each([.49, .51, 1.02, 2.04])('preserves high-frequency phase and amplitude during %s× correction', rate => {
  const reader = player(12000);
  reader.send({ type: 'play', epoch: 1, frame: 0, when: 0, end: 48000, rate });
  const samples: number[] = [];
  for (let block = 0; block < 100; block++) samples.push(...reader.render()[0]![0]!);
  const count = samples.length - 480;
  let sine = 0, cosine = 0, energy = 0;
  for (let i = 480; i < samples.length; i++) {
    const phase = 2 * Math.PI * 12000 * i / 48000;
    sine += samples[i]! * Math.sin(phase);
    cosine += samples[i]! * Math.cos(phase);
    energy += samples[i]! ** 2;
  }
  const amplitude = 2 * Math.hypot(sine, cosine) / count;
  const toneEnergy = amplitude ** 2 * count / 2;
  expect(amplitude).toBeGreaterThan(.198);
  expect(toneEnergy / energy).toBeGreaterThan(.999);
  expect(reader.instance.cursor).toBeCloseTo(samples.length * rate);
});


it('merges incremental raw and clean ranges without replaying or losing samples', () => {
  const reader = player(); reader.send({ type: 'reset', epoch: 2, frame: 100 });
  for (const [offset, end] of [[100, 300], [300, 700]]) {
    const raw = reader.raw.slice(offset, end);
    reader.send({ type: 'chunk', epoch: 2, start: 0, offset, from: 100, length: end, raw: [raw, raw] });
    reader.send({ type: 'clean-chunk', epoch: 2, start: 0, offset, from: 100, length: end, clean: Float32Array.from(raw, value => value * .5) });
  }
  reader.send({ type: 'play', epoch: 2, frame: 100, when: 0, end: 700, rate: 1 });
  for (let block = 0; block < 4; block++) {
    const output = reader.render();
    expect(output[0]![0]).toEqual(reader.raw.slice(100 + block * 128, 100 + (block + 1) * 128));
    for (let i = 0; i < 128; i++) expect(output[1]![0]![i]).toBeCloseTo(output[0]![0]![i]! * (1 - Math.min(1, (block * 128 + i + 1) / 2400) * .5), 6);
  }
});
