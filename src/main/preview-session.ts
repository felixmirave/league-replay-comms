import type { PreviewDecoder } from '../analysis/decoder-client';
import { AnalysisCache, type WaveformCacheKey } from '../library/analysis-cache';
import { sameFileVersion, type FileVersion } from '../library/model';
import type { OpenMedia } from '../shared/protocol';
import { cropSchema, type Crop, type PreviewView, type WaveformChunk } from '../shared/analysis';

export interface PreviewSource { path: string; version: FileVersion; hash?: string; media: OpenMedia }
export interface ReviewPreview {
  select(source: PreviewSource): void;
  identify(hash: string): void;
  updateMedia(media: OpenMedia): void;
  showFrame(positionSeconds: number): void;
  clear(): void;
  setCrop?(crop?: Crop): void;
  selectVideo?(index: number): void;
}

/** Keeps large preview payloads out of the 20 Hz playback status channel. */
export class PreviewSession implements ReviewPreview {
  private view: PreviewView = { revision: 0, mediaGeneration: 0 };
  private source?: PreviewSource;
  private frameAbort?: AbortController;
  private waveformAbort?: AbortController;
  private frameSequence = 0;
  private waveformSequence = 0;
  private jobs = new Set<Promise<void>>();
  private completedWaveform?: { key: Omit<WaveformCacheKey, 'hash'>; value: WaveformChunk };
  private closed = false;

  constructor(private readonly decoder: PreviewDecoder, private readonly cache: AnalysisCache, private readonly changed: () => void) {}
  snapshot(): PreviewView { return structuredClone(this.view); }
  async settled(): Promise<void> { while (this.jobs.size) await Promise.all([...this.jobs]); await this.cache.flush(); }
  close(): void { this.closed = true; this.frameAbort?.abort(); this.waveformAbort?.abort(); }
  clear(): void {
    this.frameAbort?.abort(); this.waveformAbort?.abort(); this.source = undefined; this.completedWaveform = undefined;
    this.view = { revision: this.view.revision, mediaGeneration: this.view.mediaGeneration + 1 }; this.publish();
  }
  select(source: PreviewSource): void {
    const same = this.source && ((source.hash && source.hash === this.source.hash) || (source.path === this.source.path && sameFileVersion(source.version, this.source.version)));
    const frame = same ? this.view.frame : undefined, crop = same ? this.view.crop : undefined, selectedVideo = same ? this.view.videoStreamIndex : undefined;
    this.clear(); this.source = structuredClone(source);
    this.view.frame = frame; this.view.crop = crop;
    const videos = source.media.probe?.streams.filter(stream => stream.type === 'video') ?? [];
    this.view.videoStreamIndex = videos.find(stream => stream.index === selectedVideo)?.index ?? videos[0]?.index;
    this.waveformWindow(0, source.media.durationSeconds);
    if (this.view.videoStreamIndex !== undefined && !frame) this.showFrame(Math.max(0, (videos[0]?.startPtsSeconds ?? source.media.originSeconds ?? 0) - (source.media.originSeconds ?? 0)));
    this.publish();
  }
  identify(hash: string): void {
    if (!this.source) return;
    this.source.hash = hash;
    if (this.completedWaveform) this.saveCache(hash, this.completedWaveform);
  }
  updateMedia(media: OpenMedia): void {
    if (!this.source) return;
    const changedDuration = this.source.media.durationSeconds !== media.durationSeconds;
    this.source.media = structuredClone(media);
    if (changedDuration && this.view.waveform?.startSeconds === 0) this.waveformWindow(0, media.durationSeconds);
  }
  selectVideo(index: number): void {
    if (!this.source?.media.probe?.streams.some(stream => stream.type === 'video' && stream.index === index)) throw new Error('Unknown video stream');
    if (this.view.videoStreamIndex === index) return;
    this.view.videoStreamIndex = index; this.view.crop = undefined; this.view.frame = undefined;
    this.showFrame(0);
  }
  setCrop(crop?: Crop): void {
    if (crop) cropSchema.parse(crop);
    this.view.crop = crop; this.publish();
  }
  showFrame(positionSeconds: number): void {
    const source = this.source, streamIndex = this.view.videoStreamIndex;
    if (!source || streamIndex === undefined) return;
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0 || positionSeconds >= source.media.durationSeconds) throw new Error('Frame position is outside the recording');
    if (source.media.originSeconds === undefined) { this.view.frameError = 'The recording timestamp origin is unavailable'; this.publish(); return; }
    this.frameAbort?.abort(); const abort = this.frameAbort = new AbortController();
    const generation = this.view.mediaGeneration, sequence = ++this.frameSequence;
    this.view.frameBusy = true; this.view.frameError = undefined; this.publish();
    this.background((async () => {
      try {
        const frame = await this.decoder.frame({ kind: 'frame', path: source.path, version: source.version, streamIndex, originSeconds: source.media.originSeconds!, positionSeconds }, abort.signal);
        if (this.closed || abort.signal.aborted || generation !== this.view.mediaGeneration || sequence !== this.frameSequence) return;
        this.view.frame = frame;
      } catch (error) {
        if (this.closed || abort.signal.aborted || generation !== this.view.mediaGeneration || sequence !== this.frameSequence) return;
        this.view.frameError = error instanceof Error ? error.message : String(error);
      } finally {
        if (!this.closed && generation === this.view.mediaGeneration && sequence === this.frameSequence) { this.view.frameBusy = false; this.publish(); }
      }
    })());
  }
  waveformWindow(startSeconds: number, endSeconds: number): void {
    const source = this.source;
    if (!source) return;
    if (![startSeconds, endSeconds].every(Number.isFinite) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > source.media.durationSeconds + 0.001) throw new Error('Waveform window is outside the recording');
    this.waveformAbort?.abort(); const abort = this.waveformAbort = new AbortController();
    const generation = this.view.mediaGeneration, sequence = ++this.waveformSequence;
    this.completedWaveform = undefined; this.view.waveformError = undefined;
    this.view.waveform = { peaks: [], startSeconds, endSeconds, complete: false, processedSeconds: startSeconds }; this.publish();
    const track = source.media.tracks.find(track => track.id === source.media.selectedTrackId);
    const stream = source.media.probe?.streams.find(stream => stream.type === 'audio' && stream.index === track?.ffIndex);
    const originSeconds = source.media.originSeconds;
    if (!stream?.sampleRate || originSeconds === undefined) { this.view.waveformError = 'Audio stream timing is unavailable for waveform preview'; this.publish(); return; }
    const key = { streamIndex: stream.index, originSeconds, startSeconds, endSeconds, bucketSeconds: Math.max(0.005, (endSeconds - startSeconds) / 20000), sampleRate: stream.sampleRate };
    const current = () => !this.closed && !abort.signal.aborted && generation === this.view.mediaGeneration && sequence === this.waveformSequence;
    this.background((async () => {
      try {
        const cached = source.hash && await this.cache.get({ ...key, hash: source.hash });
        if (!current()) return;
        if (cached) {
          this.view.waveform = { ...cached, complete: true, processedSeconds: endSeconds };
          this.completedWaveform = { key, value: cached }; this.publish(); return;
        }
        const peaks: WaveformChunk['peaks'] = [];
        let actualBucket = key.bucketSeconds;
        for (let at = startSeconds; at < endSeconds; at += 60) {
          const end = Math.min(endSeconds, at + 60);
          const chunk = await this.decoder.waveform({ kind: 'waveform', path: source.path, version: source.version, ...key, startSeconds: at, endSeconds: end }, abort.signal);
          if (!current()) return;
          peaks.push(...chunk.peaks); actualBucket = chunk.bucketSeconds;
          if (peaks.length > 25001) throw new Error('Waveform preview exceeds its memory limit');
          this.view.waveform = { peaks: [...peaks], startSeconds, endSeconds, processedSeconds: end, complete: false }; this.publish();
        }
        const value: WaveformChunk = { kind: 'waveform', peaks, startSeconds, endSeconds, bucketSeconds: actualBucket };
        this.completedWaveform = { key, value };
        this.view.waveform = { peaks, startSeconds, endSeconds, processedSeconds: endSeconds, complete: true }; this.publish();
        if (this.source?.hash) this.saveCache(this.source.hash, this.completedWaveform);
      } catch (error) {
        if (!current()) return;
        this.view.waveformError = error instanceof Error ? error.message : String(error); this.publish();
      }
    })());
  }
  private saveCache(hash: string, waveform: NonNullable<PreviewSession['completedWaveform']>): void {
    // Cache failures do not invalidate an in-memory preview or a saved alignment.
    this.background(this.cache.put({ ...waveform.key, hash }, waveform.value).catch(() => undefined));
  }
  private publish(): void { if (!this.closed) { this.view.revision++; this.changed(); } }
  private background(job: Promise<void>): void { const guarded = job.finally(() => this.jobs.delete(guarded)); this.jobs.add(guarded); }
}
