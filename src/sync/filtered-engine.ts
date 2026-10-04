import { audioOperationTimeoutMs } from '../shared/playback-timeouts';
import { MediaEngine } from './engine';
import type { AudioOperation, AudioReply, AudioRequest, BrowserAudioSample } from '../shared/audio-engine';
import type { MediaProbe } from '../shared/media';
import type { OpenMedia } from '../shared/protocol';
import { monotonicSeconds, type AudioSample } from '../shared/domain';
import { defaultFilters, type FilterSettings } from '../shared/filters';

/** mpv retains the native track/timestamp metadata; only the Web Audio path is audible. */
export class FilteredEngine {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private media?: OpenMedia;
  private path?: string;
  private revision = 0;
  private settings = defaultFilters();
  private volumeValue = 100;
  private failed = false;
  private interruption: Promise<void> = Promise.resolve();
  constructor(private native: MediaEngine, private send: (message: AudioRequest) => void, private interrupted: () => void) {}
  reply(message: AudioReply) {
    const call = this.pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer); this.pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error)); else call.resolve(message.data);
  }
  private request(operation: AudioOperation): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Audio processing timed out. Retry audio.')); }, audioOperationTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'audio-request', id, operation });
    });
  }
  outputState() { return { driver: 'Web Audio', revision: this.revision, devices: [] }; }
  async load(path: string, probe?: MediaProbe): Promise<OpenMedia> {
    await this.interruption;
    await this.request({ type: 'interrupt' });
    const media = await this.native.load(path, probe);
    this.path = path; this.media = media;
    await this.request({ type: 'volume', volume: this.volumeValue });
    await this.request({ type: 'filters', filters: this.settings });
    await this.loadTrack(media.selectedTrackId);
    this.revision++; this.failed = false;
    return media;
  }
  private async loadTrack(id: number) {
    const media = this.media!;
    const audioIndex = media.tracks.findIndex(track => track.id === id);
    if (audioIndex < 0) throw new Error('Unknown audio track');
    await this.request({ type: 'load', path: this.path!, audioIndex, channels: media.tracks[audioIndex]?.channels, origin: media.originSeconds ?? 0, duration: media.durationSeconds });
    media.selectedTrackId = id;
  }
  updateProbe(media: OpenMedia, probe: MediaProbe) { this.media = this.native.updateProbe(media, probe); return this.media; }
  async observe(): Promise<AudioSample> {
    const before = monotonicSeconds();
    const data = await this.request({ type: 'observe' }).catch(error => { if (!this.failed) { this.failed = true; this.interrupted(); } throw error; }) as BrowserAudioSample;
    const after = monotonicSeconds();
    return { ...data, observedAtSeconds: (before + after) / 2, uncertaintySeconds: data.uncertaintySeconds + (after - before) / 2 * data.rate, outputRevision: this.revision };
  }
  async seek(seconds: number) { await this.request({ type: 'seek', seconds }); return this.observe(); }
  async pause(paused: boolean) { await this.request({ type: 'pause', paused }); }
  async rate(rate: number) { await this.request({ type: 'rate', rate }); }
  async volume(volume: number) { this.volumeValue = volume; await this.request({ type: 'volume', volume }); }
  async filters(filters: FilterSettings) { this.settings = structuredClone(filters); await this.request({ type: 'filters', filters }); }
  async track(id: number) {
    if (this.media?.selectedTrackId === id) return;
    const position = (await this.observe()).positionSeconds;
    await this.native.track(id);
    await this.loadTrack(id);
    await this.seek(position);
    this.revision++;
  }
  interrupt(reason: string) {
    this.interruption = this.request({ type: 'interrupt' }).then(() => undefined);
    void this.interruption.catch(() => undefined);
    this.native.interrupt(reason);
    this.revision++;
  }
  async close() { await this.request({ type: 'close' }).catch(() => undefined); await this.native.close(); }
}
