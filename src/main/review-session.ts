import { basename } from 'node:path';
import { fileVersion } from '../library/identity';
import { sameFileVersion, type Alignment, type FileIdentity, type FileVersion } from '../library/model';
import { ReviewLibrary } from '../library/library';
import { relocateFile } from '../library/relocation';
import type { LibraryView, PlaybackCommand, ProbeSnapshot } from '../shared/protocol';
import type { MediaProber } from '../analysis/probe';
import { streamRange, type MediaProbe } from '../shared/media';
import type { ReviewPreview } from './preview-session';
import type { VideoClockJobs } from '../analysis/video-clock';
import { AlignmentEdits } from './alignment-edits';
import { PreferenceEdits } from './preference-edits';

export interface IdentityJobs { identify(path: string, signal?: AbortSignal, progress?: (done: number, total: number) => void): Promise<FileIdentity> }
export interface PlaybackPort { send(command: PlaybackCommand): Promise<ProbeSnapshot>; snapshot(): ProbeSnapshot }

/** Serializes session changes; slow file work runs outside the mutation queue. */
export class ReviewSession {
  private view: LibraryView;
  private runtimeId?: string;
  private recentId?: string;
  private media?: { path: string; version: FileVersion; hash?: string; importId?: string; trackKey: string; preferenceRevision: number; trackChosen: boolean; probe?: MediaProbe };
  private alignment?: Alignment;
  private mediaEpoch = 0;
  private mediaAbort?: AbortController;
  private searchAbort?: AbortController;
  private jobs = new Set<Promise<void>>();
  private changes: Promise<void> = Promise.resolve();
  private closed = false;
  private clockAbort?: AbortController;
  private clockSequence = 0;
  private initialClock?: { mediaEpoch: number; sequence: number };
  private readonly edits: AlignmentEdits;
  private exitBarrier?: Promise<void>;
  private releaseExit?: () => void;
  private volumeTimer?: ReturnType<typeof setTimeout>;
  private volumeSave: Promise<void> = Promise.resolve();

  constructor(private readonly library: ReviewLibrary, private readonly identities: IdentityJobs, private readonly playback: PlaybackPort, private readonly changed: () => void, private readonly prober?: MediaProber, private readonly previews?: ReviewPreview, private readonly clocks?: VideoClockJobs, private readonly preferences = new PreferenceEdits(library)) {
    this.edits = new AlignmentEdits(library);
    this.view = { recordings: [], mediaGeneration: 0, trackChosen: false, recordingReady: false, folders: [], warnings: [...library.warnings], volume: library.snapshot().settings.volume, missingRecording: false };
    this.refresh();
  }
  snapshot(): LibraryView {
    return structuredClone({ ...this.view, mediaGeneration: this.mediaEpoch, trackChosen: !!this.media?.trackChosen, recordingReady: !!this.media, boundToRuntime: !!this.runtimeId, alignment: this.alignment,
      saveError: [this.edits.message(), this.preferences.message()].filter(Boolean).join('\n') || undefined, unsavedAlignments: this.edits.count, unsavedPreferences: this.preferences.count });
  }
  async settled(): Promise<void> {
    do { await this.changes; await Promise.all([...this.jobs]); } while (this.jobs.size);
    await this.changes;
    if (!this.closed) await this.flushVolume().catch(() => undefined);
    await this.volumeSave; await this.library.flush(); await this.clocks?.flush?.();
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.volumeTimer);
    this.resumeAfterExit();
    this.mediaAbort?.abort(); this.searchAbort?.abort();
    this.clockAbort?.abort();
  }
  prepareExit(): Promise<void> { return this.mutate(async () => {
    // Freeze only after changes already accepted by this session have completed.
    // Hash/OCR completions may queue behind this barrier until cancel or close.
    this.exitBarrier = new Promise(resolve => { this.releaseExit = resolve; });
    await this.retryExitSave();
  }); }
  async retryExitSave(): Promise<void> {
    if (!this.exitBarrier) throw new Error('Prepare the session before saving on exit');
    try { await this.retryPending(); } catch { /* The remaining edits and their errors are shown in the exit decision. */ }
    await this.library.flush(); this.changed();
  }
  resumeAfterExit(): void {
    const release = this.releaseExit;
    this.exitBarrier = undefined; this.releaseExit = undefined; release?.();
  }
  onPlayback(snapshot: ProbeSnapshot): void {
    if (this.runtimeId && (snapshot.connectionError || snapshot.replay?.sessionId !== this.runtimeId)) {
      this.runtimeId = undefined; this.view.status = 'Connection changed. Resume listening when League is ready.'; this.changed();
    }
  }
  selectRecording(id: string): Promise<void> { return this.mutate(async () => {
    const data = this.library.snapshot();
    if (id.startsWith('media:') ? !data.media[id.slice(6)] : !id.startsWith('pending:') || !data.pendingImports[id.slice(8)]) throw new Error('This recent recording is no longer available. Choose its file.');
    this.mediaAbort?.abort(); this.searchAbort?.abort(); this.mediaEpoch++; this.media = undefined;
    this.previews?.clear(); await this.clearAlignment();
    if (this.playback.snapshot().media) await this.playback.send({ type: 'preview', paused: true });
    this.recentId = id; await this.restoreRecording();
  }); }
  enterTiming(): Promise<void> { return this.mutate(async () => {
    this.cancelClock(); this.runtimeId = undefined;
    if (this.media) await this.playback.send({ type: 'preview', paused: true });
  }); }
  stop(): Promise<void> { return this.mutate(async () => {
    this.runtimeId = undefined;
    if (this.playback.snapshot().media) await this.playback.send({ type: 'preview', paused: true });
    this.changed();
  }); }

  openMedia(path: string): Promise<void> { return this.mutate(() => this.loadMedia(path)); }
  analyzeVideo(): Promise<void> { return this.mutate(async () => { this.beginVideoAnalysis(); }); }
  cancelClock(notify = true): void { this.clockAbort?.abort(); this.clockSequence++; this.view.clock = undefined; if (notify) this.changed(); }
  seekPreview(positionSeconds: number): Promise<void> { return this.mutate(async () => {
    await this.playback.send({ type: 'seek-preview', positionSeconds });
  }); }
  setManualOffset(offsetSeconds: number, correctionSeconds = 0): Promise<void> { return this.mutate(() => this.manualOffset(offsetSeconds, correctionSeconds)); }
  alignHere(): Promise<void> { return this.mutate(async () => {
    const state = await this.playback.send({ type: 'align-here' });
    if (state.offsetSeconds === undefined) throw new Error('Could not establish an alignment');
    await this.manualOffset(state.offsetSeconds);
  }); }
  nudge(deltaSeconds: number): Promise<void> { return this.mutate(async () => {
    if (!this.alignment) throw new Error('Set an alignment first');
    if (!Number.isFinite(deltaSeconds)) throw new Error('Enter a finite correction');
    this.searchAbort?.abort();
    this.cancelClock(); this.view.alignmentConflict = false;
    this.alignment = { ...this.alignment, correctionSeconds: this.alignment.correctionSeconds + deltaSeconds, revision: this.library.nextAlignmentRevision(), updatedAt: new Date().toISOString() };
    await this.applyAndPersist();
  }); }
  selectTrack(id: number, confirm = true): Promise<void> { return this.mutate(async () => {
    if (!this.media) throw new Error('Open a recording first');
    if (this.playback.snapshot().media?.selectedTrackId === id && this.media.trackChosen && confirm) return;
    this.searchAbort?.abort();
    await this.playback.send({ type: 'preview', paused: true });
    await this.clearAlignment();
    const selected = await this.playback.send({ type: 'track', trackId: id });
    this.media.trackKey = this.trackKey(selected);
    this.media.trackChosen = confirm;
    this.media.preferenceRevision = this.library.nextAlignmentRevision();
    if (selected.media) this.previews?.select({ ...this.media, media: selected.media });
    await this.restoreTiming(); this.changed();
    await this.saveTrackPreference();
    this.initialClock = { mediaEpoch: this.mediaEpoch, sequence: this.clockSequence }; this.maybeStartInitialClock();
  }); }
  follow(): Promise<void> { return this.mutate(async () => {
    const runtime = this.currentRuntime();
    if (!runtime) throw new Error('Open a replay in League before listening.');
    if (!this.media?.trackChosen) throw new Error('Choose the track containing your comms first.');
    if (!this.alignment) throw new Error('Set an alignment first');
    this.runtimeId = runtime;
    try { await this.applyAlignment(); await this.playback.send({ type: 'follow' }); }
    catch (error) { this.runtimeId = undefined; throw error; }
  }); }
  retrySave(): Promise<void> { return this.mutate(() => this.retryPending()); }
  setVolume(volume: number): Promise<void> { return this.mutate(async () => {
    // Publish accepted intent before acknowledging playback. Persistence must
    // neither delay the next slider input nor flash a save-failure warning.
    this.preferences.stageVolume(volume);
    this.refresh();
    clearTimeout(this.volumeTimer);
    this.volumeTimer = setTimeout(() => { void this.flushVolume().catch(() => undefined); }, 250);
    await this.playback.send({ type: 'volume', volume });
  }); }
  addFolder(path: string): Promise<void> { return this.mutate(async () => {
    const folders = this.preferences.settings().mediaFolders;
    try { if (!folders.includes(path)) await this.preferences.setting('mediaFolders', [...folders, path]); }
    finally { this.refresh(); }
    if (this.view.missingRecording) await this.restoreRecording();
  }); }
  locateMedia(path: string): Promise<void> { return this.mutate(async () => {
    const hash = this.recentId?.startsWith('media:') ? this.recentId.slice(6) : undefined;
    if (!hash || !this.library.snapshot().media[hash]) throw new Error('Choose the missing recording from your recent recordings first.');
    const epoch = this.mediaEpoch;
    this.searchAbort?.abort(); const abort = this.searchAbort = new AbortController();
    this.view.status = 'Verifying the located recording…'; this.view.error = undefined; this.view.locating = true; this.changed();
    this.background((async () => {
      const identity = await this.identities.identify(path, abort.signal);
      await this.mutate(async () => {
        if (epoch !== this.mediaEpoch || abort.signal.aborted) return;
        if (identity.sha256 !== hash) throw new Error('This is a different recording. Choose another file to restore the saved timing, or open it as a new recording.');
        await this.loadMedia(path, identity);
      });
    })().finally(() => { if (epoch === this.mediaEpoch) { this.view.locating = false; this.changed(); } }), () => !abort.signal.aborted && epoch === this.mediaEpoch);
  }); }

  private async loadMedia(path: string, verified?: FileIdentity, restoreTrack?: string, provisionalVersion?: FileVersion): Promise<void> {
    this.searchAbort?.abort(); this.mediaAbort?.abort();
    const abort = this.mediaAbort = new AbortController();
    const epoch = ++this.mediaEpoch;
    this.media = undefined; this.view.alignmentConflict = false; this.view.locating = false;
    this.previews?.clear();
    await this.clearAlignment();
    this.initialClock = { mediaEpoch: epoch, sequence: this.clockSequence };
    this.view.recording = { path }; this.view.missingRecording = false;
    this.view.timingAnalysis = undefined;
    this.view.status = 'Opening recording…'; this.view.error = undefined; this.changed();
    const version = await fileVersion(path);
    if (provisionalVersion && !sameFileVersion(version, provisionalVersion)) throw new Error('The unfinished recording changed since import. Open it again to start a new review; its earlier alignment has not been applied.');
    if (verified && !sameFileVersion(version, verified.version)) throw new Error('Recording changed after verification. Locate it again.');
    if (this.playback.snapshot().media) await this.playback.send({ type: 'preview', paused: true });
    const cachedIdentity = verified ?? this.library.cachedIdentity(path, version);
    const probe = (cachedIdentity && this.library.snapshot().media[cachedIdentity.sha256]?.probe?.data) ?? await this.prober?.inspect(path, abort.signal);
    let opened = await this.playback.send({ type: 'load', path, probe });
    if (!opened.media) throw new Error('Recording did not open');
    if (!sameFileVersion(version, await fileVersion(path))) throw new Error('Recording changed while opening. Reopen it before restoring an alignment.');
    await this.playback.send({ type: 'volume', volume: this.preferences.settings().volume });
    const provisional = await this.library.beginImport(path, version);
    if (!restoreTrack) restoreTrack = this.preferences.preferredTrack({ path, version, hash: cachedIdentity?.sha256, importId: provisional.id })?.trackKey;
    let restoredTrack = false;
    if (restoreTrack) {
      const track = opened.media.tracks.find(track => (track.ffIndex === undefined ? `mpv:${track.id}` : `ff:${track.ffIndex}`) === restoreTrack);
      if (!track) this.view.error = 'The saved audio track is unavailable. Choose a track and check its alignment.';
      else { restoredTrack = true; if (track.id !== opened.media.selectedTrackId) opened = await this.playback.send({ type: 'track', trackId: track.id }); }
    }
    this.media = { path, version, importId: provisional.id, trackKey: this.trackKey(opened), preferenceRevision: this.library.nextAlignmentRevision(), trackChosen: restoredTrack || opened.media!.tracks.length === 1, probe };
    this.previews?.select({ path, version, hash: cachedIdentity?.sha256, media: opened.media! });
    await this.restoreTiming();
    await this.saveTrackPreference().catch(() => undefined);
    this.view.status = 'Identifying recording in the background…'; this.changed();
    this.background((async () => {
      const identity = verified ?? this.library.cachedIdentity(path, version) ?? await this.identities.identify(path, abort.signal, (done, total) => {
        if (epoch === this.mediaEpoch && this.view.recording && !this.closed) { this.view.recording.progress = total ? done / total : 1; this.changed(); }
      });
      await this.mutate(async () => {
        if (abort.signal.aborted || epoch !== this.mediaEpoch) return;
        if (!sameFileVersion(version, identity.version) || !sameFileVersion(version, await fileVersion(path))) throw new Error('Recording changed since it was opened. Reopen it before saving alignment.');
        const previousPreference = this.preferences.preferredTrack({ ...this.media!, hash: identity.sha256 });
        await this.library.completeImport(provisional.id, identity, this.media!.probe);
        this.edits.identifyMedia(provisional.id, identity);
        this.preferences.identifyMedia(provisional.id, identity);
        this.media!.hash = identity.sha256; this.media!.importId = undefined;
        // A default decoder track chosen before hashing must not overwrite a saved
        // choice discovered at a renamed path. A new manual choice/anchor wins.
        if (!this.media!.trackChosen && !this.alignment && previousPreference) {
          const track = this.playback.snapshot().media?.tracks.find(track => (track.ffIndex === undefined ? `mpv:${track.id}` : `ff:${track.ffIndex}`) === previousPreference.trackKey);
          if (track) {
            this.media!.trackChosen = true;
            if (previousPreference.trackKey !== this.media!.trackKey) {
            const selected = await this.playback.send({ type: 'track', trackId: track.id });
            this.media!.trackKey = this.trackKey(selected);
            if (selected.media) this.previews?.select({ ...this.media!, media: selected.media });
            }
          }
        }
        this.background(this.clocks?.identify?.(provisional.id, identity) ?? Promise.resolve(), () => false);
        this.previews?.identify(identity.sha256);
        this.view.recording = { path: identity.path, hash: identity.sha256, progress: 1 };
        if (this.alignment) await this.persistAlignment(); else await this.restoreTiming();
        await this.saveTrackPreference().catch(() => undefined);
        this.view.status = this.alignment ? 'Recording identified and alignment restored' : 'Recording identified. Set an alignment.';
        this.refresh();
        this.maybeStartInitialClock();
      });
    })(), () => epoch === this.mediaEpoch && !abort.signal.aborted);
    if (probe && this.prober?.inspectRanges && opened.media?.tracks.some(track => !track.range)) {
      this.view.timingAnalysis = 'running'; this.changed();
      this.background((async () => {
        const detailed = await this.prober!.inspectRanges!(path, probe, abort.signal);
        await this.mutate(async () => {
          if (epoch !== this.mediaEpoch || abort.signal.aborted) return;
          if (!sameFileVersion(version, await fileVersion(path))) throw new Error('Recording changed while reading audio timing. Reopen it.');
          this.media!.probe = detailed;
          const updated = await this.playback.send({ type: 'update-probe', probe: detailed });
          if (updated.media) this.previews?.updateMedia(updated.media);
          if (this.media!.hash) await this.library.saveProbe(this.media!.hash, detailed);
          await this.applyAlignment();
          this.view.timingAnalysis = updated.media?.tracks.some(track => !track.range) ? 'failed' : undefined;
          this.changed();
        });
      })().catch(error => {
        if (epoch === this.mediaEpoch && !abort.signal.aborted) { this.view.timingAnalysis = 'failed'; this.changed(); }
        throw error;
      }), () => epoch === this.mediaEpoch && !abort.signal.aborted);
    }
  }
  private async manualOffset(offsetSeconds: number, correctionSeconds = 0): Promise<void> {
    if (!Number.isFinite(offsetSeconds) || !Number.isFinite(correctionSeconds) || Math.abs(offsetSeconds + correctionSeconds) > 86_400) throw new Error('Enter a finite offset within 24 hours');
    if (!this.media) throw new Error('Open a recording first');
    this.searchAbort?.abort();
    this.cancelClock(); this.view.alignmentConflict = false;
    this.alignment = { baseOffsetSeconds: offsetSeconds, correctionSeconds, source: 'manual', revision: this.library.nextAlignmentRevision(), updatedAt: new Date().toISOString() };
    await this.applyAndPersist();
  }
  private maybeStartInitialClock(): void {
    // Restore recording timing before initial automation can replace anything.
    if (!this.initialClock || this.initialClock.mediaEpoch !== this.mediaEpoch || this.initialClock.sequence !== this.clockSequence || !this.media?.hash
      || !this.media.trackChosen || this.view.alignmentConflict || this.alignment || this.view.clock || !this.clocks || this.playback.snapshot().media?.originSeconds === undefined) return;
    if (this.media.probe?.streams.some(stream => stream.type === 'video')) this.beginVideoAnalysis(false);
  }
  private beginVideoAnalysis(force = true): void {
    const media = this.media, opened = this.playback.snapshot().media;
    const video = media?.probe?.streams.find(stream => stream.type === 'video');
    if (!this.clocks || !media || !opened || !video || opened.originSeconds === undefined) throw new Error('Open a video recording with usable timestamps first');
    const streamIndex = video.index;
    this.cancelClock(false);
    const abort = this.clockAbort = new AbortController();
    const sequence = this.clockSequence, mediaEpoch = this.mediaEpoch, revision = this.alignment?.revision;
    const current = () => !this.closed && !abort.signal.aborted && sequence === this.clockSequence && mediaEpoch === this.mediaEpoch && revision === this.alignment?.revision && media.trackKey === this.media?.trackKey;
    const originSeconds = opened.originSeconds;
    const range = streamRange(video, media.probe!, originSeconds);
    const request = { path: media.path, version: media.version, hash: media.hash, importId: media.importId, force, streamIndex, originSeconds,
      startSeconds: range?.startSeconds ?? Math.max(0, (video.startPtsSeconds ?? originSeconds) - originSeconds), endSeconds: Math.min(opened.durationSeconds, range?.endSeconds ?? opened.durationSeconds) };
    this.view.clock = { status: 'running', message: 'Finding the recorded game clock…', framesRead: 0 }; this.changed();
    const operation = this.clocks.analyze(request, abort.signal, progress => {
      if (!current()) return;
      const stage = { 'locating-clock': 'Finding the clock', 'finding-transition': 'Finding consecutive frames at a clock tick' }[progress.stage];
      this.view.clock = { status: 'running', message: `${stage}…`, framesRead: progress.framesRead }; this.changed();
    }).then(result => this.mutate(async () => {
      if (!current()) return;
      if (!sameFileVersion(media.version, await fileVersion(media.path))) throw new Error('Recording changed during clock analysis. Reopen it.');
      if (!current()) return;
      const fit = result.fit;
      if (fit.status === 'needs-attention') this.view.clock = { status: fit.status, message: fit.message, framesRead: result.framesRead };
      else {
        this.view.clock = { status: fit.status, framesRead: result.framesRead, offsetSeconds: fit.offsetSeconds, uncertaintySeconds: fit.uncertaintySeconds,
          message: 'Aligned from the recorded game clock.' };
        if (fit.status === 'accepted') {
          if (!result.crop) throw new Error('Clock alignment lacks its clock crop');
          this.alignment = { baseOffsetSeconds: fit.offsetSeconds, correctionSeconds: 0, source: 'video-clock', revision: this.library.nextAlignmentRevision(), updatedAt: new Date().toISOString(),
            clock: { crop: result.crop, videoStreamIndex: streamIndex, originSeconds, evidence: fit.evidence } };
          await this.applyAndPersist();
        }
      }
      this.changed();
    })).catch(error => {
      if (!current()) return;
      this.view.clock = { status: 'needs-attention', message: error instanceof Error ? error.message : String(error), framesRead: this.view.clock?.framesRead ?? 0 }; this.changed();
    });
    this.background(operation, current);
  }
  private async restoreRecording(): Promise<void> {
    const data = this.library.snapshot(), id = this.recentId;
    if (!id) return;
    this.view.error = undefined; this.view.missingRecording = false;
    if (id.startsWith('pending:')) {
      const pending = data.pendingImports[id.slice(8)];
      if (!pending) throw new Error('This unfinished import is no longer available. Choose the recording again.');
      try { await this.loadMedia(pending.path, undefined, pending.preferredTrack?.trackKey, pending.version); }
      catch (error) {
        this.view.error = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'The unfinished recording’s original path is missing. Choose the recording again.' : error instanceof Error ? error.message : String(error);
        this.view.status = undefined; this.changed();
      }
      return;
    }
    const file = data.media[id.slice(6)]; if (!file) return;
    const epoch = this.mediaEpoch;
    this.searchAbort?.abort(); const abort = this.searchAbort = new AbortController();
    this.view.recording = { path: file.locations[0]?.path ?? file.name, hash: file.hash };
    this.view.status = 'Finding the saved recording…'; this.view.locating = true; this.changed();
    this.background((async () => {
      const identity = await relocateFile(file, this.preferences.settings().mediaFolders, (path, signal) => this.identities.identify(path, signal), abort.signal);
      await this.mutate(async () => {
        if (epoch !== this.mediaEpoch || abort.signal.aborted) return;
        this.view.locating = false;
        if (!identity) { this.view.missingRecording = true; this.view.status = 'Saved recording not found. Locate its file.'; this.changed(); return; }
        await this.loadMedia(identity.path, identity);
      });
    })().finally(() => { if (epoch === this.mediaEpoch) { this.view.locating = false; this.changed(); } }), () => epoch === this.mediaEpoch && !abort.signal.aborted);
  }
  private async restoreTiming(): Promise<void> {
    if (this.alignment || !this.media) return;
    const { hash, importId, trackKey } = this.media;
    const saved = hash ? this.library.timing(hash, trackKey) : undefined;
    const pending = importId ? this.library.snapshot().pendingImports[importId]?.edits[trackKey] : undefined;
    this.view.alignmentConflict = !!(hash ? this.library.conflicts(hash, trackKey).length : importId && this.library.snapshot().pendingImports[importId]?.conflicts[trackKey]?.length);
    const draft = this.edits.lookup(this.media, trackKey);
    this.alignment = [draft, pending, saved?.alignment].filter((value): value is Alignment => !!value).sort((a, b) => b.revision - a.revision)[0];
    if (this.alignment) {
      this.cancelClock();
      await this.applyAlignment();
    }
    this.changed();
  }
  private async persistAlignment(): Promise<void> {
    const alignment = this.alignment, media = this.media;
    if (!alignment || !media) return;
    try {
      await this.edits.save(media, media.trackKey, alignment);
      this.view.status = media.hash ? 'Recording and alignment saved' : 'Alignment saved while recording identification continues.';
      this.refresh();
    } finally { this.changed(); }
  }
  private async applyAlignment(): Promise<void> {
    await this.playback.send({ type: 'apply-alignment', offsetSeconds: this.alignment && this.alignment.baseOffsetSeconds + this.alignment.correctionSeconds, replaySessionId: this.runtimeId });
  }
  private async applyAndPersist(): Promise<void> {
    // An engine failure must not prevent saving an edit; a disk failure must not
    // prevent auditioning it. Keep the in-memory intent and report either error.
    const results = await Promise.allSettled([this.applyAlignment(), this.persistAlignment()]);
    this.changed();
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  private async clearAlignment(): Promise<void> {
    this.cancelClock();
    this.alignment = undefined; this.runtimeId = undefined;
    await this.playback.send({ type: 'apply-alignment' });
  }
  private trackKey(snapshot: ProbeSnapshot): string {
    const track = snapshot.media?.tracks.find(track => track.id === snapshot.media?.selectedTrackId);
    if (!track) throw new Error('Selected audio track is unavailable');
    return track.ffIndex === undefined ? `mpv:${track.id}` : `ff:${track.ffIndex}`;
  }
  private currentRuntime(): string | undefined { const state = this.playback.snapshot(); return state.connectionError ? undefined : state.replay?.sessionId; }
  private async saveTrackPreference(): Promise<void> {
    if (!this.media?.trackChosen) return;
    try { await this.preferences.preferTrack(this.media, this.media.trackKey, this.media.preferenceRevision); }
    finally { this.changed(); }
  }
  private async retryPending(): Promise<void> {
    clearTimeout(this.volumeTimer);
    await this.volumeSave;
    const results = await Promise.allSettled([this.edits.retry(), this.preferences.retry()]);
    this.refresh();
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), this.snapshot().saveError);
  }
  private flushVolume(): Promise<void> {
    clearTimeout(this.volumeTimer);
    const operation = this.volumeSave.then(() => this.preferences.flushVolume()).finally(() => this.refresh());
    // Errors stay attached to the retained preference and are published above.
    this.volumeSave = operation.catch(() => undefined);
    return operation;
  }
  private refresh(): void {
    const data = this.library.snapshot();
    this.view.recordings = [
      ...Object.values(data.media).map(file => ({ id: `media:${file.hash}`, name: file.name, path: file.locations[0]?.path ?? file.name, updatedAt: file.lastOpenedAt ?? '', pending: false })),
      ...Object.values(data.pendingImports).map(file => ({ id: `pending:${file.id}`, name: basename(file.path), path: file.path, updatedAt: file.createdAt, pending: true })),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const settings = this.preferences.settings();
    this.view.folders = settings.mediaFolders; this.view.volume = settings.volume; this.changed();
  }
  private mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.changes.then(async () => { await this.exitBarrier; if (this.closed) throw new Error('Review session closed'); return operation(); });
    this.changes = result.catch(() => undefined);
    return result;
  }
  private background(operation: Promise<void>, relevant: () => boolean): void {
    const guarded = operation.catch(async error => {
      if (this.closed) return;
      await this.mutate(async () => {
        if (!relevant()) return;
        this.view.error = error instanceof Error ? error.message : String(error); this.view.status = undefined; this.changed();
      }).catch(() => undefined);
    }).finally(() => this.jobs.delete(guarded));
    this.jobs.add(guarded);
  }
}
