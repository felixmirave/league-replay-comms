import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MpvIpc } from './mpv-ipc';
import { monotonicSeconds, type AudioSample } from '../shared/domain';
import type { OpenMedia, Track } from '../shared/protocol';
import { streamRange, timelineVersion, type MediaProbe } from '../shared/media';
import { AudioOutputGuard, type OutputState } from './output';

export class MediaEngine {
  private child?: ChildProcess;
  private ipc?: MpvIpc;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pipe?: string;
  private loaded = false;
  private restartSerial = 0;
  private failure?: string;
  private recentStderr = '';
  private readonly output: AudioOutputGuard;
  private selectedTrack?: number;
  private tracks: Track[] = [];
  private pauseRevision = 0;

  constructor(private readonly executable: string, private readonly script: string, private readonly testAudioOutput?: 'null', interrupted?: (state: OutputState) => void) {
    this.output = new AudioOutputGuard(state => {
      // Do not wait for a reply from the output being replaced. The owner can
      // reopen it paused; standalone callers also cannot leave stale audio playing.
      this.interrupt(state.error!);
      interrupted?.(state);
    }, testAudioOutput === 'null');
  }

  outputState(): OutputState { return this.output.snapshot(); }

  async start(): Promise<void> {
    if (this.ipc && !this.failure) return;
    if (this.ipc || this.child) await this.close();
    this.failure = undefined;
    this.recentStderr = '';
    this.output.reset();
    const name = `league-replay-comms-${randomUUID()}`;
    this.pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
    const child = spawn(this.executable, ['--no-config', '--idle=yes', '--keep-open=yes', '--pause=yes', '--vid=no', '--terminal=no', '--audio-pitch-correction=yes', '--rebase-start-time=yes',
      '--input-default-bindings=no', `--input-ipc-server=${this.pipe}`, `--script=${this.script}`, ...(this.testAudioOutput ? ['--ao=null'] : [])], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    child.on('error', error => { if (this.child === child) this.failure = error.message; });
    child.stderr?.on('data', data => { if (this.child === child) this.recentStderr = (this.recentStderr + String(data)).slice(-8000); });
    child.on('exit', () => { if (this.child !== child) return; this.loaded = false; this.failure ??= 'Media engine exited'; this.ipc?.close(new Error(this.failure)); });
    // Cold native-library loading can exceed four seconds under disk contention.
    // This startup allowance is separate from the short steady-state IPC deadlines.
    const deadline = monotonicSeconds() + 15;
    while (!this.ipc) {
      if (this.failure) throw new Error(this.failure);
      if (monotonicSeconds() >= deadline) { await this.close(); throw new Error(`Could not connect to bundled mpv. ${this.recentStderr}`); }
      try {
        const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
          const connection = createConnection(this.pipe!);
          connection.once('error', reject);
          connection.once('connect', () => { connection.removeListener('error', reject); resolve(connection); });
        });
        this.ipc = new MpvIpc(socket);
      } catch { await delay(30); }
    }
    const ipc = this.ipc;
    ipc.on('event', event => {
      if (this.ipc !== ipc) return;
      if (event.event === 'playback-restart') this.restartSerial++;
      if (event.event === 'file-loaded') this.loaded = true;
      if (event.event === 'end-file' && event.reason === 'error') this.failure = `Cannot play recording: ${String(event.file_error ?? 'decoder error')}`;
      this.output.event(event);
    });
    ipc.on('disconnect', (error: Error) => { if (this.ipc === ipc) this.failure = error.message; });
    await this.command(['script-message', 'comms-heartbeat']);
    this.heartbeat = setInterval(() => { void this.command(['script-message', 'comms-heartbeat']).catch(() => undefined); }, 250);
    await this.command(['enable_event', 'audio-reconfig']);
    for (const [id, name] of ['current-ao', 'audio-device-list', 'audio-device'].entries()) await this.command(['observe_property', id + 1, name]);
  }

  async load(path: string, probe?: MediaProbe): Promise<OpenMedia> {
    await this.start();
    this.output.reset(true);
    return this.changingOutput(async ipc => {
      this.failure = undefined;
      this.loaded = false;
      this.selectedTrack = undefined;
      const serial = this.restartSerial;
      await this.pause(true);
      await ipc.command(['loadfile', path, 'replace']);
      await this.until(() => this.loaded && this.restartSerial > serial, 'Opening recording timed out');
      const duration = await this.property('duration', ipc);
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('Recording has no usable duration');
      const raw = await this.property('track-list', ipc);
      if (!Array.isArray(raw)) throw new Error('Media engine did not report tracks');
      const rawOrigin = await this.property('demuxer-start-time', ipc).catch(() => undefined);
      const originSeconds = typeof rawOrigin === 'number' && Number.isFinite(rawOrigin) ? rawOrigin : undefined;
      const tracks: Track[] = raw.filter(t => t.type === 'audio' && Number.isInteger(t.id)).map(t => {
        const stream = probe?.streams.find(stream => stream.type === 'audio' && stream.index === t['ff-index']);
        return { id: t.id, title: t.title || stream?.title || `Audio ${t.id}`, language: t.lang ?? stream?.language, selected: !!t.selected, ffIndex: t['ff-index'],
          range: stream && probe && originSeconds !== undefined ? streamRange(stream, probe, originSeconds) : undefined };
      });
      if (!tracks.length) throw new Error('Recording contains no audio track');
      this.tracks = tracks;
      const selected = tracks.find(t => t.selected) ?? tracks[0]!;
      this.selectedTrack = selected.id;
      await ipc.command(['set_property', 'aid', selected.id]);
      await this.waitForOutput(ipc, true);
      this.output.arm();
      const media = { name: basename(path), durationSeconds: duration, tracks, selectedTrackId: selected.id, originSeconds, probe, timelineVersion };
      return probe ? this.updateProbe(media, probe) : media;
    });
  }

  updateProbe(media: OpenMedia, probe: MediaProbe): OpenMedia {
    const updated = updateMediaProbe(media, probe);
    this.tracks = updated.tracks;
    return updated;
  }

  async observe(): Promise<AudioSample> {
    const ipc = this.connection(), revision = this.output.revision;
    const before = monotonicSeconds();
    const [audioPts, timePos, paused, seeking, speed, driver, tracks] = await Promise.all([
      this.property('audio-pts', ipc).catch(() => undefined), this.property('time-pos', ipc), this.property('pause', ipc), this.property('seeking', ipc), this.property('speed', ipc),
      this.property('current-ao', ipc).catch(() => undefined), this.property('track-list', ipc),
    ]);
    const after = monotonicSeconds();
    if (this.ipc !== ipc) throw new Error('Media engine was replaced');
    this.output.assertStable(revision);
    this.output.verify(driver, tracks, this.selectedTrack);
    const position = paused === true ? timePos : audioPts;
    if (typeof position !== 'number' || !Number.isFinite(position) || typeof speed !== 'number' || typeof paused !== 'boolean' || typeof seeking !== 'boolean') throw new Error('Recording clock is not ready');
    return { positionSeconds: position, observedAtSeconds: (before + after) / 2, uncertaintySeconds: (after - before) / 2 * speed, rate: speed, paused, seeking, outputRevision: revision };
  }

  async seek(positionSeconds: number): Promise<AudioSample> {
    return this.changingOutput(async ipc => {
      await this.pause(true);
      let sample: AudioSample | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        // Some mpv/output combinations retain old driver delay across a paused seek.
        // Reopen the output once if actual position checks fail; never subtract a
        // guessed buffer duration or report the command target as an observation.
        if (attempt) await ipc.command(['ao-reload']);
        const serial = this.restartSerial;
        await ipc.command(['seek', positionSeconds, 'absolute+exact']);
        await this.until(() => this.restartSerial > serial, 'Recording seek did not restart');
        await this.waitForOutput(ipc, true);
        for (let observation = 0; observation < 4; observation++) {
          sample = await this.observe();
          if (!sample.seeking && Math.abs(sample.positionSeconds - positionSeconds) <= 0.025) return sample;
          await delay(15);
        }
      }
      throw new Error(`Recording seek position could not be verified (wanted ${positionSeconds}, observed ${sample?.positionSeconds})`);
    });
  }

  async pause(paused: boolean): Promise<void> {
    const revision = ++this.pauseRevision, ipc = this.connection();
    if (!paused) {
      await this.until(() => !this.output.changing || revision !== this.pauseRevision, 'Audio output is still changing');
      if (revision !== this.pauseRevision || this.ipc !== ipc) return;
      await this.checkOutput(ipc);
      if (revision !== this.pauseRevision || this.ipc !== ipc) return;
    }
    await ipc.command(['set_property', 'pause', paused]);
  }
  async rate(rate: number): Promise<void> {
    await this.changingOutput(async ipc => {
      await ipc.command(['set_property', 'speed', rate]);
      await this.waitForOutput(ipc);
    });
  }
  async volume(volume: number): Promise<void> { await this.command(['set_property', 'volume', volume]); }
  async track(id: number): Promise<void> {
    await this.changingOutput(async ipc => {
      const tracks = await this.property('track-list', ipc);
      if (!Array.isArray(tracks) || !tracks.some(track => track.type === 'audio' && track.id === id)) throw new Error('Unknown audio track');
      await this.pause(true);
      const changed = this.selectedTrack !== id;
      const position = changed ? await this.property('time-pos', ipc).catch(() => undefined) : undefined;
      this.selectedTrack = id;
      await ipc.command(['set_property', 'aid', id]);
      await this.waitForOutput(ipc, true);
      // Track selection itself need not emit playback-restart. A precise paused
      // seek verifies the new stream at the retained preview position instead.
      if (changed && typeof position === 'number' && Number.isFinite(position)) {
        const range = this.tracks.find(track => track.id === id)?.range;
        const target = range && (position < range.startSeconds || position >= range.endSeconds) ? range.startSeconds : position;
        await this.seek(Math.max(0, target));
      }
    });
  }
  private connection(): MpvIpc {
    if (!this.ipc) throw new Error(this.failure ?? 'Media engine not started');
    return this.ipc;
  }
  private property(name: string, ipc = this.connection()): Promise<unknown> {
    if (this.ipc !== ipc) return Promise.reject(new Error('Media engine was replaced'));
    return ipc.command(['get_property', name]);
  }
  private async changingOutput<T>(run: (ipc: MpvIpc) => Promise<T>): Promise<T> {
    const ipc = this.connection(), end = this.output.begin();
    try {
      const result = await run(ipc);
      if (this.ipc !== ipc) throw new Error('Media engine was replaced');
      this.output.assertStable();
      return result;
    } finally { end(); }
  }
  private async checkOutput(ipc: MpvIpc, requirePaused = false): Promise<void> {
    const revision = this.output.revision;
    const [driver, tracks, paused, seeking] = await Promise.all([
      this.property('current-ao', ipc).catch(() => undefined), this.property('track-list', ipc), this.property('pause', ipc), this.property('seeking', ipc),
    ]);
    if (this.ipc !== ipc) throw new Error('Media engine was replaced');
    this.output.assertStable(revision);
    this.output.verify(driver, tracks, this.selectedTrack);
    if (seeking !== false || (requirePaused && paused !== true)) throw new Error('Audio output has not settled');
  }
  private async waitForOutput(ipc: MpvIpc, requirePaused = false): Promise<void> {
    const deadline = monotonicSeconds() + 2;
    for (;;) {
      try { await this.checkOutput(ipc, requirePaused); return; }
      catch (error) {
        if (this.ipc !== ipc || this.failure || monotonicSeconds() >= deadline) throw error;
        await delay(10);
      }
    }
  }
  private command(command: unknown[]): Promise<unknown> {
    if (!this.ipc) return Promise.reject(new Error('Media engine not started'));
    return this.ipc.command(command);
  }
  private async until(condition: () => boolean, message: string): Promise<void> {
    const deadline = monotonicSeconds() + 2;
    while (!condition()) {
      if (this.failure) throw new Error(this.failure);
      if (monotonicSeconds() > deadline) throw new Error(message);
      await delay(10);
    }
  }
  /** Stop output without waiting for an IPC reply during a power interruption. */
  interrupt(reason: string): void {
    this.output.disarm();
    this.pauseRevision++;
    clearInterval(this.heartbeat);
    this.failure = reason;
    this.ipc?.close(new Error(reason));
    this.ipc = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.loaded = false;
    if (this.pipe && process.platform !== 'win32') void rm(this.pipe, { force: true }).catch(() => undefined);
  }
  async close(): Promise<void> {
    this.output.disarm();
    this.pauseRevision++;
    clearInterval(this.heartbeat);
    try { await this.ipc?.command(['quit']); } catch { /* Closing a quit socket is expected. */ }
    this.ipc?.close();
    this.ipc = undefined;
    this.child?.kill();
    this.child = undefined;
    if (this.pipe && process.platform !== 'win32') await rm(this.pipe, { force: true });
    this.loaded = false;
  }
}

/** Updates derived timing without reopening the recording or moving the playhead. */
export function updateMediaProbe(media: OpenMedia, probe: MediaProbe): OpenMedia {
  const origin = media.originSeconds;
  const tracks = media.tracks.map(track => {
    const stream = probe.streams.find(stream => stream.type === 'audio' && stream.index === track.ffIndex);
    return { ...track, range: stream && origin !== undefined ? streamRange(stream, probe, origin) : undefined };
  });
  const ranges = origin !== undefined ? probe.streams.map(stream => streamRange(stream, probe, origin)) : [];
  const durationSeconds = ranges.length && ranges.every(range => range !== undefined) ? Math.max(...ranges.map(range => range.endSeconds)) : media.durationSeconds;
  return { ...media, probe, tracks, durationSeconds };
}
