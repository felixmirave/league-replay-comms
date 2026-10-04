import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalReplayTransport } from '../src/sync/replay';
import { startReplaySimulator } from '../scripts/replay-simulator';

describe('real HTTPS replay boundary', () => {
  it('verifies TLS and exercises actual sockets, invalid responses and deadlines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comms-replay-tls-'));
    let simulator: Awaited<ReturnType<typeof startReplaySimulator>> | undefined;
    let transport: LocalReplayTransport | undefined;
    try {
      const certificate = join(directory, 'ca.pem'), key = join(directory, 'ca.key');
      await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=Replay test', '-addext', 'subjectAltName=IP:127.0.0.1']);
      simulator = await startReplaySimulator({ certificate, key, log: join(directory, 'requests.jsonl') });
      transport = new LocalReplayTransport(await readFile(certificate, 'utf8'), simulator.port);
      expect(await transport.get('/replay/game', AbortSignal.timeout(1000))).toEqual({ processID: 1000 });
      simulator.timeline.set({ time: 90, speed: 2, paused: true });
      expect(await transport.get('/replay/playback', AbortSignal.timeout(1000))).toMatchObject({ time: 90, speed: 2, paused: true });
      for (const [fault, message] of [['json', 'invalid JSON'], ['oversize', 'too large'], ['http', 'HTTP 503']] as const) {
        simulator.timeline.set({ fault });
        await expect(transport.get('/replay/playback', AbortSignal.timeout(1000))).rejects.toThrow(message);
      }
      simulator.timeline.set({ fault: 'delay', delayMs: 350 });
      await expect(transport.get('/replay/playback', AbortSignal.timeout(50))).rejects.toThrow();
      simulator.timeline.set({ fault: 'none' });
      const untrusted = new LocalReplayTransport('', simulator.port);
      try { await expect(untrusted.get('/replay/game', AbortSignal.timeout(1000))).rejects.toThrow(); }
      finally { untrusted.close(); }
      const invalid = await fetch(simulator.controlUrl + '/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speed: -1 }) });
      expect(invalid.status).toBe(400);
    } finally { transport?.close(); await simulator?.close(); await rm(directory, { recursive: true, force: true }); }
  }, 10000);
});
