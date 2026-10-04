import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { z } from 'zod';

export const replayControlSchema = z.object({
  time: z.number().finite().min(0).max(86400).optional(),
  speed: z.number().finite().min(0).max(64).optional(),
  paused: z.boolean().optional(), seeking: z.boolean().optional(),
  length: z.number().finite().min(0).max(86400).optional(),
  processID: z.number().int().positive().optional(),
  fault: z.enum(['none', 'offline', 'delay', 'json', 'schema', 'oversize', 'http']).optional(),
  delayMs: z.number().int().min(0).max(10000).optional(),
}).strict();
export type ReplayControl = z.infer<typeof replayControlSchema>;
export interface ReplayState { time: number; speed: number; paused: boolean; seeking: boolean; length: number; processID: number; fault: NonNullable<ReplayControl['fault']>; delayMs: number }
export const seconds = () => performance.now() / 1000;

/** Independent replay clock: never reads the application's state or controller. */
export class ReplayTimeline {
  private anchor: number;
  private value: ReplayState = { time: 8, speed: 1, paused: true, seeking: false, length: 3600, processID: 1000, fault: 'none', delayMs: 350 };
  readonly events: { at: number; state: ReplayState }[] = [];
  private readonly clock: () => number;
  constructor(clock = seconds) { this.clock = clock; this.anchor = clock(); this.events.push({ at: this.anchor, state: { ...this.value } }); }
  at(at = this.clock()): ReplayState {
    const event = [...this.events].reverse().find(event => event.at <= at) ?? this.events[0]!;
    const state = { ...event.state };
    if (!state.paused && !state.seeking) state.time = Math.min(state.length, state.time + Math.max(0, at - event.at) * state.speed);
    return state;
  }
  set(input: ReplayControl): ReplayState {
    const patch = replayControlSchema.parse(input);
    const at = this.clock();
    this.value = { ...this.at(at), ...patch };
    this.anchor = at;
    this.events.push({ at, state: { ...this.value } });
    return { ...this.value };
  }
}
export function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Use application/json');
  let text = '';
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 16384) throw new Error('Control request is too large');
  }
  return JSON.parse(text);
}
export async function startReplaySimulator(options: {
  certificate: string; key: string; log: string;
  handle?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
}) {
  const timeline = new ReplayTimeline();
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let logQueue = Promise.resolve();
  const log = (value: unknown) => { logQueue = logQueue.then(() => appendFile(options.log, JSON.stringify(value) + '\n')); };
  const secure = httpsServer({ cert: await readFile(options.certificate), key: await readFile(options.key) }, (request, response) => {
    const state = timeline.at();
    log({ at: seconds(), request: request.url, state });
    if (request.url !== '/replay/playback' && request.url !== '/replay/game') { json(response, { error: 'Unknown endpoint' }, 404); return; }
    if (request.method !== 'GET') { json(response, { error: 'Use GET' }, 405); return; }
    if (state.fault === 'offline') { request.socket.destroy(); return; }
    const reply = () => {
      if (response.destroyed) return;
      if (state.fault === 'http') { json(response, { error: 'Injected failure' }, 503); return; }
      if (state.fault === 'json') { response.end('{invalid'); return; }
      if (state.fault === 'oversize') { response.end(' '.repeat(65537)); return; }
      if (state.fault === 'schema') { json(response, { time: 'invalid' }); return; }
      const current = timeline.at();
      json(response, request.url === '/replay/game' ? { processID: current.processID } : { time: current.time, speed: current.speed, paused: current.paused, seeking: current.seeking, length: current.length });
    };
    if (state.fault === 'delay') {
      const timer = setTimeout(() => { timers.delete(timer); reply(); }, state.delayMs);
      timers.add(timer);
    } else reply();
  });
  const control = httpServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/state') { json(response, timeline.at()); return; }
      if (request.method === 'POST' && request.url === '/control') {
        const state = timeline.set(replayControlSchema.parse(await body(request)));
        log({ at: seconds(), control: state }); json(response, state); return;
      }
      if (await options.handle?.(request, response)) return;
      json(response, { error: 'Unknown control endpoint' }, 404);
    })().catch(error => json(response, { error: String(error) }, 400));
  });
  for (const server of [secure, control]) server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([secure, control].map(server => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
    })));
    await logQueue;
  };
  try {
    for (const server of [secure, control]) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    const secureAddress = secure.address(), controlAddress = control.address();
    if (!secureAddress || typeof secureAddress === 'string' || !controlAddress || typeof controlAddress === 'string') throw new Error('Missing simulator address');
    return { timeline, port: secureAddress.port, controlUrl: `http://127.0.0.1:${controlAddress.port}`, close };
  } catch (error) { await close(); throw error; }
}
