import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { beforeAll, expect, it } from 'vitest';

let code: string;
beforeAll(async () => {
  code = (await transform(await readFile('src/audio/ahead-worker.ts', 'utf8'), {
    loader: 'ts', format: 'iife', define: { 'import.meta.url': '"http://fixture/ahead-worker.js"' },
  })).code;
});

it.each([480, 501, 48120])('publishes all %s decoded frames without padding a longer video', async frames => {
  const samples = Float32Array.from({ length: frames * 2 }, (_, i) => (i % 50) / 100);
  const chunks = new Map<number, { start: number; length: number; raw: Float32Array[] }>();
  let transferredFrames = 0;
  let finish!: (message: { end: number }) => void, fail!: (error: Error) => void;
  const completed = new Promise<{ end: number }>((resolve, reject) => { finish = resolve; fail = reject; });
  const sandbox = createContext({ performance, AbortController, Response, URL, setTimeout,
    fetch: async () => new Response(new Uint8Array(samples.buffer)),
    postMessage: (message: { type: string; start: number; offset: number; length: number; raw: Float32Array[]; end: number; message: string }) => {
      if (message.type === 'chunk') {
        if (message.start + message.length > frames) throw new Error('Published invented audio after EOF');
        let chunk = chunks.get(message.start);
        if (!chunk) { chunk = { start: message.start, length: 0, raw: [new Float32Array(48000), new Float32Array(48000)] }; chunks.set(message.start, chunk); }
        expect(message.offset).toBe(chunk.length);
        transferredFrames += message.raw[0]!.length;
        for (let channel = 0; channel < 2; channel++) chunk.raw[channel]!.set(message.raw[channel]!, message.offset);
        chunk.length = message.length;
      }
      if (message.type === 'error') fail(new Error(message.message));
      if (message.type === 'complete') finish(message);
    },
  });
  runInContext(code, sandbox);
  sandbox.onmessage({ data: { type: 'init', source: 'http://fixture/pcm', total: 60 * 48000, noise: false } });
  sandbox.onmessage({ data: { type: 'prepare', epoch: 1, start: 0, end: 3 * 48000, noise: false } });
  expect((await completed).end).toBe(frames);
  for (let frame = 0; frame < frames; frame++) {
    const start = Math.floor(frame / 48000) * 48000, chunk = chunks.get(start)!;
    expect(chunk.raw[0]![frame - start]).toBe(samples[frame * 2]);
    expect(chunk.raw[1]![frame - start]).toBe(samples[frame * 2 + 1]);
  }
  expect(transferredFrames).toBe(frames);
  expect(chunks.size).toBe(Math.ceil(frames / 48000));
});
