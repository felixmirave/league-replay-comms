import { seekTimeoutSeconds } from '../shared/playback-timeouts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Synchronizer, initialControllerConfig } from './controller';
import { MediaEngine } from './engine';
import { FilteredEngine } from './filtered-engine';
import type { AudioReply } from '../shared/audio-engine';
import { defaultFilters } from '../shared/filters';
import { LocalReplayTransport, ReplayConnection } from './replay';
import { monotonicSeconds, type ControllerEvent, type Binding } from '../shared/domain';
import { initialSnapshot, type ProbeSnapshot, type WorkerRequest, type WorkerResponse } from '../shared/protocol';
import { PlaybackRecovery } from './recovery';
import { fileVersion } from '../library/identity';
import { sameFileVersion, type FileVersion } from '../library/model';
import type { MediaProbe } from '../shared/media';
import { DiagnosticTrace } from './trace';

const resources = process.argv[2];
if (!resources || !process.parentPort) throw new Error('Sync process requires its resource path and parent port');
const parent = process.parentPort;
const controllerConfig = { ...initialControllerConfig, seekTimeoutSeconds, settleSeconds: 0 };
const controller = new Synchronizer(controllerConfig);
const nativeEngine = new MediaEngine(join(resources, 'bin', process.platform === 'win32' ? 'win32-x64/mpv.exe' : 'linux-x64/mpv'), join(resources, 'scripts/heartbeat.lua'), 'null', output => {
  record('output-interrupted', output);
  if (!closing && recovery.state === 'active') void recovery.recover('Audio output changed', 'output');
});
const engine = new FilteredEngine(nativeEngine, message => parent.postMessage(message), () => { if (!closing && recovery.state === 'active') void recovery.recover('Audio output was interrupted', 'output'); });
let filters = defaultFilters();
let snapshot: ProbeSnapshot = structuredClone(initialSnapshot);
let closing = false;
let loading = false;
let observing = false;
let engineSeek: Promise<void> | undefined;
let lastParentHeartbeat = monotonicSeconds();
let parentInterrupted = false;
let lastTickAt = lastParentHeartbeat;
let lastPowerSequence = 0;
let lastPowerState: 'suspend' | 'resume' | undefined;
let mediaGeneration = 0;
let boundSession: string | undefined;
let needsOutputBinding = false;
let commandQueue = Promise.resolve();
const requests = new Map<number, { canceled: boolean; active: boolean; generation: number; timer?: ReturnType<typeof setTimeout> }>();
function cancelRequest(id: number) {
  const request = requests.get(id);
  if (!request || request.canceled) return;
  request.canceled = true;
  if (request.active && request.generation === recovery.generation && !closing) {
    // Invalidate physical work immediately; the existing recovery path drains
    // the canceled command before reopening the last accepted recording.
    const scope = recovery.busy ? 'runtime' : 'output';
    recovery.suspend('Playback operation timed out', scope);
    void recovery.recover('Playback operation timed out', scope);
  }
}
let lastRecording: { path: string; version: FileVersion; probe?: MediaProbe } | undefined;
let volume = 100;
const trace = new DiagnosticTrace();
let tracedBinding: Binding | undefined;
let lastAudioAtSeconds: number | undefined;
const send = (message: WorkerResponse) => parent.postMessage(message);
const record = (event: string, data: unknown) => trace.record(event, data);
const currentSnapshot = (): ProbeSnapshot => ({ ...snapshot, audioOutput: engine.outputState(), busy: loading || recovery.busy });

function dispatch(event: ControllerEvent): void {
  if (recovery.state !== 'active' && event.type !== 'reset' && event.type !== 'failure') return;
  const now = monotonicSeconds();
  const actions = controller.update(event, now);
  if (event.type === 'bind') tracedBinding = { ...event.binding };
  if (event.type === 'unbind' || event.type === 'reset') tracedBinding = undefined;
  if (event.type === 'reset') lastAudioAtSeconds = undefined;
  if (event.type === 'audio' || event.type === 'seek-complete') lastAudioAtSeconds = event.sample.observedAtSeconds;
  snapshot.sync = controller.snapshot();
  if (event.type !== 'tick' && event.type !== 'audio' && event.type !== 'replay') trace.record('controller-input', event, now);
  trace.record('controller', { cause: event.type, status: snapshot.sync, nominalReplayRate: snapshot.replay?.speed,
    reportedReplayAgeSeconds: snapshot.replay ? now - snapshot.replay.receivedAtSeconds : undefined,
    reportedAudioAgeSeconds: lastAudioAtSeconds === undefined ? undefined : now - lastAudioAtSeconds }, now);
  if (actions.length) record('actions', actions);
  for (const action of actions) {
    if (!snapshot.media || recovery.state !== 'active' || closing) continue;
    if (action.type === 'seek') {
      const generation = mediaGeneration;
      const currentSeek = engine.seek(action.targetSeconds).then(sample => {
        if (generation === mediaGeneration) dispatch({ type: 'seek-complete', generation: action.generation, sample });
      }).catch(error => {
        if (generation === mediaGeneration) dispatch({ type: 'seek-failed', generation: action.generation, message: error instanceof Error ? error.message : String(error) });
      }).finally(() => { if (engineSeek === currentSeek) engineSeek = undefined; });
      engineSeek = currentSeek;
    } else {
      const generation = mediaGeneration;
      void (action.type === 'pause' ? engine.pause(action.paused) : engine.rate(action.rate)).catch(error => { if (generation === mediaGeneration) fail(error); });
    }
  }
}
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  snapshot.error = message;
  record('failure', message);
  dispatch({ type: 'failure', message });
}
const developmentReplay = process.argv[4] === '--development-replay';
const replayPort = developmentReplay ? Number(process.argv[5]) : 2999;
const replayCertificate = developmentReplay ? process.argv[6] : join(resources, 'certificates/riotgames.pem');
if (!replayCertificate) throw new Error('Replay API certificate path is required');
const replay = new ReplayConnection(new LocalReplayTransport(readFileSync(replayCertificate, 'utf8'), replayPort), sample => {
  snapshot.replay = sample;
  snapshot.connectionError = undefined;
  if (boundSession && boundSession !== sample.sessionId) {
    snapshot.offsetSeconds = undefined; boundSession = undefined; needsOutputBinding = false;
    dispatch({ type: 'unbind' });
  }
  record('replay', sample);
  dispatch({ type: 'replay', sample });
  restoreOutputBinding();
}, message => { snapshot.connectionError = message; record('connection-error', message); });
const recovery = new PlaybackRecovery({
  interrupt: (reason, scope) => {
    mediaGeneration++;
    engine.interrupt(reason);
    if (scope === 'runtime') {
      replay.stop();
      snapshot.connectionError = `${reason}. Waiting for fresh replay state.`;
    }
    needsOutputBinding = true;
    snapshot.error = undefined; snapshot.suppressionError = undefined; snapshot.paused = true;
    dispatch({ type: 'reset' });
    record('interruption', reason);
  },
  drain: async () => { await commandQueue; await engineSeek; },
  restore: restoreRecording,
  ready: scope => {
    snapshot.error = undefined;
    dispatch({ type: 'retry' });
    if (scope === 'runtime') replay.start();
    else {
      const latest = snapshot.replay;
      if (latest && !snapshot.connectionError && monotonicSeconds() - latest.receivedAtSeconds < 0.3) {
        dispatch({ type: 'replay', sample: latest });
      }
      restoreOutputBinding();
    }
  },
  failed: error => { engine.interrupt('Recovery failed'); fail(error); },
  changed: () => send({ type: 'snapshot', snapshot: currentSnapshot() }),
});
replay.start();

function restoreOutputBinding(): void {
  if (!needsOutputBinding || recovery.state !== 'active') return;
  const latest = snapshot.replay;
  const range = snapshot.media?.tracks.find(track => track.id === snapshot.media?.selectedTrackId)?.range;
  if (latest && range && !snapshot.connectionError && monotonicSeconds() - latest.receivedAtSeconds < 0.3 && boundSession === latest.sessionId && snapshot.offsetSeconds !== undefined) {
    needsOutputBinding = false;
    dispatch({ type: 'bind', binding: { replaySessionId: boundSession, offsetSeconds: snapshot.offsetSeconds, startSeconds: range.startSeconds, endSeconds: range.endSeconds } });
  }
}

async function restoreRecording(): Promise<void> {
  const source = lastRecording, previous = snapshot.media, generation = mediaGeneration;
  if (!source || !previous) return;
  const unchanged = async () => {
    const current = await fileVersion(source.path).catch(() => { throw new Error('Recording is unavailable at its previous location. Reopen it before reviewing.'); });
    if (!sameFileVersion(source.version, current)) throw new Error('Recording changed since it was opened. Open it again before reviewing.');
  };
  await unchanged();
  const media = await engine.load(source.path, source.probe);
  await unchanged();
  if (media.originSeconds !== previous.originSeconds) throw new Error('Recording timestamps changed during recovery. Open it again before reviewing.');
  const oldTrack = previous.tracks.find(track => track.id === previous.selectedTrackId);
  const track = media.tracks.find(track => oldTrack?.ffIndex === undefined ? track.id === oldTrack?.id : track.ffIndex === oldTrack.ffIndex);
  if (!track) throw new Error('The selected audio track is unavailable after recovery. Open the recording again.');
  await engine.track(track.id);
  await engine.rate(1);
  const position = snapshot.positionSeconds;
  if (position !== undefined && position > 0 && position < media.durationSeconds && (!track.range || (position >= track.range.startSeconds && position < track.range.endSeconds))) await engine.seek(position);
  let appliedVolume: number;
  do { appliedVolume = volume; await engine.volume(appliedVolume); } while (appliedVolume !== volume);
  await engine.filters(filters);
  const observed = await engine.observe();
  if (!observed.paused || observed.seeking) throw new Error('Restored output has not settled while paused');
  await unchanged();
  if (generation !== mediaGeneration) return;
  media.selectedTrackId = track.id;
  snapshot.media = media; snapshot.paused = true; snapshot.positionSeconds = observed.positionSeconds;
  dispatch({ type: 'retry' });
  record('recovery-ready', { selectedTrackId: track.id, output: engine.outputState() });
}

const ticker = setInterval(() => {
  const now = monotonicSeconds(), gap = now - lastTickAt;
  lastTickAt = now;
  // On Windows the monotonic clock includes sleep. A power callback can arrive
  // after this timer: stop the old player before applying either watchdog.
  if (gap > 1 && !closing && !parentInterrupted) {
    lastParentHeartbeat = now;
    void recovery.recover('Playback timer was interrupted');
  }
  const parentAge = now - lastParentHeartbeat;
  // A briefly stalled main process is recoverable. Silence output immediately,
  // retaining its alignment, and wait for a real heartbeat before restoring it.
  // Only a prolonged loss of the parent retires this orphaned worker.
  if (parentAge > 30) { record('parent-unavailable', { seconds: parentAge }); void close(); return; }
  if (parentAge > 2 && !parentInterrupted && !closing) {
    parentInterrupted = true;
    record('parent-interrupted', { seconds: parentAge });
    recovery.suspend('Application response was interrupted', 'output');
  }
  if (recovery.state !== 'active') { send({ type: 'snapshot', snapshot: currentSnapshot() }); return; }
  dispatch({ type: 'tick' });
  if (snapshot.media && !loading && !observing && !engineSeek) {
    observing = true;
    const generation = mediaGeneration;
    void engine.observe().then(sample => {
      if (generation !== mediaGeneration) return;
      snapshot.suppressionError = sample.suppressionError;
      snapshot.positionSeconds = sample.positionSeconds;
      snapshot.paused = sample.paused;
      record('audio', sample);
      dispatch({ type: 'audio', sample });
    }).catch(error => { record('audio-unavailable', String(error)); }).finally(() => { observing = false; });
  }
  send({ type: 'snapshot', snapshot: currentSnapshot() });
}, 50);

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  recovery.suspend('Closing application');
  clearInterval(ticker);
  replay.stop();
  await engine.close();
  process.exit(0);
}

parent.on('message', ({ data }: { data: WorkerRequest | AudioReply }) => {
  if ('type' in data && data.type === 'audio-reply') { engine.reply(data); return; }
  if ('type' in data) {
    if (data.type === 'cancel') { cancelRequest(data.id); return; }
    if (data.type === 'heartbeat') {
      lastParentHeartbeat = monotonicSeconds();
      if (parentInterrupted && !closing) {
        parentInterrupted = false;
        record('parent-restored', {});
        if (lastPowerState !== 'suspend') void recovery.recover('Application response restored', 'output');
      }
    }
    else if (data.type === 'power' && data.sequence > lastPowerSequence && !closing) {
      lastPowerSequence = data.sequence;
      if (data.state !== lastPowerState) {
        lastPowerState = data.state;
        lastParentHeartbeat = monotonicSeconds();
        if (data.state === 'suspend') recovery.suspend();
        else void recovery.recover('System resumed');
      }
    }
    return;
  }
  if (data.deadline !== undefined && data.deadline <= Date.now()) { send({ type: 'reply', id: data.id, error: 'Playback operation timed out' }); return; }
  if (data.command.type === 'retry') {
    if (recovery.state === 'suspended' || closing) { send({ type: 'reply', id: data.id, error: 'Wait for the system to resume before retrying playback.' }); return; }
    const retry = { canceled: false, active: true, generation: recovery.generation, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    requests.set(data.id, retry);
    if (data.deadline !== undefined) retry.timer = setTimeout(() => cancelRequest(data.id), Math.max(0, data.deadline - Date.now()));
    const work = recovery.recover('Retrying playback'); retry.generation = recovery.generation;
    void work.then(() => send({ type: 'reply', id: data.id, ...(retry.canceled ? { error: 'Playback operation timed out' } : recovery.state === 'failed' ? { error: snapshot.error } : { data: currentSnapshot() }) })).finally(() => { clearTimeout(retry.timer); requests.delete(data.id); });
    return;
  }
  if (data.command.type === 'filters') filters = data.command.filters;
  if (data.command.type === 'volume') volume = data.command.volume;
  if (recovery.busy && data.command.type !== 'close' && data.command.type !== 'trace') {
    if (data.command.type === 'apply-alignment') {
      // The main process retains this edit even if its playback request fails.
      // Recovery must not resume the older alignment after that newer intent.
      needsOutputBinding = false; boundSession = undefined; snapshot.offsetSeconds = undefined;
    }
    send({ type: 'reply', id: data.id, error: 'Playback was interrupted. Wait for recovery, then try again.' }); return;
  }
  const generation = recovery.generation;
  const request = { canceled: false, active: false, generation, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  requests.set(data.id, request);
  if (data.deadline !== undefined) request.timer = setTimeout(() => cancelRequest(data.id), Math.max(0, data.deadline - Date.now()));
  commandQueue = commandQueue.then(async () => {
    if (data.deadline !== undefined && data.deadline <= Date.now()) cancelRequest(data.id);
    if (request.canceled) throw new Error('Playback operation timed out');
    request.active = true;
    const allowedAfterFailure = data.command.type === 'load' || data.command.type === 'filters' || data.command.type === 'apply-alignment' || (data.command.type === 'preview' && data.command.paused);
    if (data.command.type !== 'close' && data.command.type !== 'trace') recovery.assertActive(generation, allowedAfterFailure);
    const result = await handle(data);
    if (request.canceled) throw new Error('Playback operation timed out');
    return result;
  }).then(result => send({ type: 'reply', id: data.id, data: result ?? currentSnapshot() })).catch(error => {
    const message = request.canceled ? 'Playback operation timed out' : error instanceof Error ? error.message : String(error);
    if (!request.canceled) snapshot.error = message;
    send({ type: 'reply', id: data.id, error: message });
  }).finally(() => { clearTimeout(request.timer); requests.delete(data.id); });
});

async function handle(request: Extract<WorkerRequest, { command: unknown }>): Promise<unknown> {
  const command = request.command;
  if (command.type === 'trace') return trace.snapshot({ controllerConfig, controller: snapshot.sync,
    binding: tracedBinding, offsetSeconds: snapshot.offsetSeconds, replay: snapshot.replay, output: engine.outputState(),
    media: snapshot.media ? { selectedTrackId: snapshot.media.selectedTrackId, originSeconds: snapshot.media.originSeconds,
      durationSeconds: snapshot.media.durationSeconds, timelineVersion: snapshot.media.timelineVersion } : undefined,
    mediaGeneration, recovery: recovery.state });
  record('user-intent', command.type === 'load' ? { type: command.type, path: command.path } : command.type === 'update-probe' ? { type: command.type } : command);
  if (command.type === 'close') return close();
  if (command.type === 'preview' && command.paused && recovery.state === 'failed') {
    // Opening another recording and normal exit both silence first. The failed
    // replacement has already terminated its player, so that prerequisite is met.
    snapshot.paused = true;
    return;
  }
  if (loading) throw new Error('Wait for the recording to finish opening');
  if (command.type === 'filters') {
    // Opening a replacement applies preferences before loading. This must also
    // work after failed recovery, without clearing the playback error.
    filters = command.filters;
    await engine.filters(filters);
    return;
  }
  snapshot.error = undefined;
  if (command.type === 'apply-alignment') {
    needsOutputBinding = command.replaySessionId !== undefined && command.offsetSeconds !== undefined;
    snapshot.offsetSeconds = command.offsetSeconds;
    boundSession = command.replaySessionId;
    dispatch({ type: 'unbind' });
    const latest = snapshot.replay;
    const range = snapshot.media?.tracks.find(track => track.id === snapshot.media?.selectedTrackId)?.range;
    if (command.offsetSeconds !== undefined && !Number.isFinite(command.offsetSeconds)) throw new Error('Invalid alignment');
    if (snapshot.media && range && command.offsetSeconds !== undefined && latest && latest.sessionId === boundSession && monotonicSeconds() - latest.receivedAtSeconds < 0.3) {
      needsOutputBinding = false;
      dispatch({ type: 'bind', binding: { replaySessionId: latest.sessionId, offsetSeconds: command.offsetSeconds, startSeconds: range.startSeconds, endSeconds: range.endSeconds } });
    }
    if (command.replaySessionId && command.offsetSeconds !== undefined && range) {
      if (controller.snapshot().state === 'preview') dispatch({ type: 'mode', mode: 'follow' });
    } else dispatch({ type: 'mode', mode: 'preview' });
    return;
  }
  if (command.type === 'load') {
    needsOutputBinding = false;
    loading = snapshot.busy = true;
    mediaGeneration++;
    boundSession = undefined;
    snapshot.offsetSeconds = undefined;
    dispatch({ type: 'mode', mode: 'preview' });
    dispatch({ type: 'unbind' });
    await engineSeek;
    snapshot.media = undefined;
    lastRecording = undefined;
    try {
      const version = await fileVersion(command.path), generation = mediaGeneration;
      const media = await engine.load(command.path, command.probe);
      if (generation !== mediaGeneration) throw new Error('Opening the recording was interrupted. Open it again.');
      if (!sameFileVersion(version, await fileVersion(command.path))) { engine.interrupt('Recording changed'); throw new Error('Recording changed while opening. Open it again.'); }
      snapshot.media = media; lastRecording = { path: command.path, version, probe: command.probe };
      record('output-ready', engine.outputState());
      snapshot.positionSeconds = undefined; snapshot.paused = true; dispatch({ type: 'retry' });
      recovery.replacementLoaded();
    }
    finally { loading = snapshot.busy = false; }
    return;
  }
  if (command.type === 'retry') throw new Error('Retry must pass through playback recovery');
  if (!snapshot.media) throw new Error('Open a recording first');
  if (command.type === 'update-probe') { snapshot.media = engine.updateProbe(snapshot.media, command.probe); if (lastRecording) lastRecording.probe = command.probe; return; }
  if (command.type === 'preview' || command.type === 'track') {
    dispatch({ type: 'mode', mode: 'preview' });
    await engineSeek;
  }
  if (command.type === 'preview') { await engine.rate(1); await engine.pause(command.paused); }
  if (command.type === 'track') {
    if (!snapshot.media.tracks.some(track => track.id === command.trackId)) throw new Error('Unknown audio track');
    await engine.track(command.trackId);
    snapshot.media.selectedTrackId = command.trackId;
    snapshot.offsetSeconds = undefined;
    dispatch({ type: 'unbind' });
  }
  if (command.type === 'volume') { volume = command.volume; await engine.volume(volume); }
}
