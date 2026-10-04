import https from 'node:https';
import { playbackSchema, monotonicSeconds, type ReplaySample } from '../shared/domain';

export interface ReplayTransport { get(path: '/replay/playback' | '/replay/game', signal: AbortSignal): Promise<unknown>; close(): void }

export class LocalReplayTransport implements ReplayTransport {
  private readonly agent: https.Agent;
  constructor(certificate: string, private readonly port = 2999) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Replay API port');
    this.agent = new https.Agent({ ca: certificate, keepAlive: true, maxSockets: 2 }); }
  get(path: '/replay/playback' | '/replay/game', signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = https.get({ host: '127.0.0.1', port: this.port, path, agent: this.agent, signal }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`Replay API returned HTTP ${response.statusCode}`)); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) { request.destroy(new Error('Replay API response too large')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Replay API returned invalid JSON')); } });
      });
      request.on('error', reject);
    });
  }
  close(): void { this.agent.destroy(); }
}

/** One request at a time. The controller owns freshness independently of this loop. */
export class ReplayConnection {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: AbortController;
  private sessionId?: string;
  private lastIdentityAt = -Infinity;
  private failures = 0;
  private epoch = 0;

  constructor(
    private readonly transport: ReplayTransport,
    private readonly onSample: (sample: ReplaySample) => void,
    private readonly onError: (message: string) => void,
    private readonly clock = monotonicSeconds,
  ) {}

  start(): void {
    if (this.running) return;
    this.lastIdentityAt = -Infinity;
    this.failures = 0;
    this.running = true;
    const epoch = ++this.epoch;
    void this.poll(epoch);
  }
  stop(): void { this.running = false; this.epoch++; clearTimeout(this.timer); this.active?.abort(); this.transport.close(); }

  private async poll(epoch: number): Promise<void> {
    if (!this.running || epoch !== this.epoch) return;
    const startedAt = this.clock();
    try {
      // A connection failure is not evidence of a new viewer. Verify the PID
      // before publishing playback on first connection and after interruptions.
      if (startedAt - this.lastIdentityAt >= 2) {
        const game = await this.request('/replay/game');
        if (!this.running || epoch !== this.epoch) return;
        if (typeof game !== 'object' || game === null || !('processID' in game)
          || !Number.isSafeInteger(game.processID) || (game.processID as number) <= 0) throw new Error('Replay process identity is unavailable');
        this.sessionId = `process:${game.processID}`;
        this.lastIdentityAt = startedAt;
      }
      if (!this.running || epoch !== this.epoch) return;
      const sentAtSeconds = this.clock();
      const raw = await this.request('/replay/playback');
      const receivedAtSeconds = this.clock();
      if (!this.running || epoch !== this.epoch) return;
      const result = playbackSchema.safeParse(raw);
      if (!result.success) throw new Error('Unsupported Replay API playback response');
      const p = result.data;
      this.failures = 0;
      this.onSample({ sessionId: this.sessionId!, timeSeconds: p.time, speed: p.speed, paused: p.paused, seeking: p.seeking,
        lengthSeconds: p.length, sentAtSeconds, receivedAtSeconds });
    } catch (error) {
      if (!this.running || epoch !== this.epoch) return;
      this.lastIdentityAt = -Infinity;
      this.failures++;
      this.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.running && epoch === this.epoch) {
        const delay = this.failures ? Math.min(2000, 100 * 2 ** Math.min(this.failures, 4)) : Math.max(0, 50 - (this.clock() - startedAt) * 1000);
        this.timer = setTimeout(() => void this.poll(epoch), delay);
      }
    }
  }

  private async request(path: '/replay/game' | '/replay/playback'): Promise<unknown> {
    const abort = new AbortController();
    this.active = abort;
    const timeout = setTimeout(() => abort.abort(new Error('Replay API request timed out')), 200);
    try { return await this.transport.get(path, abort.signal); }
    finally { clearTimeout(timeout); if (this.active === abort) this.active = undefined; }
  }
}
