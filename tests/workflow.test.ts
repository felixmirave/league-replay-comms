import { describe, expect, it } from 'vitest';
import { GuidedWorkflow } from '../src/main/workflow';
import { initialSnapshot, type ProbeSnapshot } from '../src/shared/protocol';

function facts(connected = true): ProbeSnapshot {
  return { ...structuredClone(initialSnapshot), library: { recordings: [], mediaGeneration: 0, recordingReady: false, trackChosen: false, folders: [], volume: 100, warnings: [], missingRecording: false },
    replay: connected ? { sessionId: 'runtime', timeSeconds: 10, paused: true, seeking: false, speed: 1, lengthSeconds: 2000, sentAtSeconds: 0, receivedAtSeconds: 0 } : undefined,
    setup: { searching: false, installations: [], warnings: [] } };
}
function recording(state: ProbeSnapshot) {
  Object.assign(state.library!, { recordingReady: true, trackChosen: true, mediaGeneration: 1, recording: { path: 'comms.wav', hash: 'a'.repeat(64) } });
  state.media = { name: 'comms.wav', durationSeconds: 2000, selectedTrackId: 1, tracks: [{ id: 1, title: 'Comms', selected: true, range: { startSeconds: 0, endSeconds: 2000, evidence: 'packet-scan' } }] };
}
function align(state: ProbeSnapshot) { state.library!.alignment = { baseOffsetSeconds: 12, correctionSeconds: 0, source: 'manual', revision: 1, updatedAt: '2026-01-01' }; }

describe('guided review state machine', () => {
  it('keeps startup loading and failures separate from League setup, including partial initialization', () => {
    const flow = new GuidedWorkflow(), state = facts();
    state.startup = 'loading';
    expect(flow.observe(state)).toMatchObject({ state: 'starting', primary: undefined });
    state.startup = 'failed'; state.error = 'Could not initialize services';
    expect(flow.observe(state)).toMatchObject({ state: 'application.error', primary: undefined });
    state.startup = 'ready'; state.error = undefined;
    expect(flow.observe(state)).toMatchObject({ state: 'recording.choose', primary: 'Choose recording' });
  });
  it('guides installation, API enablement, connection, recording and timing with one primary action', () => {
    const flow = new GuidedWorkflow(), state = facts(false);
    expect(flow.observe(state)).toMatchObject({ state: 'setup.folder', primary: 'Choose League folder' });
    state.setup!.installations = [{ root: 'League', configs: [{ path: 'League/game.cfg', inspection: { state: 'disabled', missing: false } }] }];
    expect(flow.observe(state).state).toBe('setup.installation');
    state.setup!.selectedRoot = 'League';
    expect(flow.observe(state).state).toBe('setup.enable');
    state.setup!.installations[0]!.configs[0]!.inspection = { state: 'enabled' };
    expect(flow.observe(state)).toMatchObject({ state: 'replay.wait', primary: undefined });
    state.replay = facts().replay;
    expect(flow.observe(state)).toMatchObject({ state: 'recording.choose', primary: 'Choose recording' });
    recording(state); expect(flow.observe(state).state).toBe('alignment.manual');
    align(state); flow.complete(); expect(flow.observe(state)).toMatchObject({ state: 'ready', primary: 'Start listening' });
    state.library!.boundToRuntime = true; state.sync.state = 'paused';
    expect(flow.observe(state).state).toBe('listening');
    state.connectionError = 'Disconnected'; state.library!.boundToRuntime = false;
    expect(flow.observe(state).state).toBe('replay.wait');
    state.connectionError = undefined;
    expect(flow.observe(state).state).toBe('ready');
  });
  it('skips setup when League is already reachable, without requesting any replay identity', () => {
    const flow = new GuidedWorkflow(), state = facts();
    state.setup!.searching = true;
    expect(flow.observe(state).state).toBe('recording.choose');
    recording(state); align(state);
    expect(flow.observe(state).state).toBe('ready');
  });
  it('does not open a blank editor before saved timing can be restored', () => {
    const flow = new GuidedWorkflow(), state = facts(); recording(state);
    state.library!.recording!.hash = undefined;
    expect(flow.observe(state).state).toBe('recording.identifying');
    state.library!.recording!.hash = 'a'.repeat(64); align(state);
    expect(flow.observe(state).state).toBe('ready');
  });
  it('pins explicit manual work through hashing, OCR results, disconnect and reconnect', () => {
    const flow = new GuidedWorkflow(), state = facts(); recording(state);
    state.library!.recording!.hash = undefined; flow.observe(state);
    flow.send('edit', state);
    const editor = flow.observe(state);
    state.library!.recording!.hash = 'a'.repeat(64); align(state);
    state.library!.clock = { status: 'accepted', offsetSeconds: 99, framesRead: 12, message: 'Late result' };
    state.connectionError = 'Disconnected';
    expect(flow.observe(state)).toMatchObject({ state: 'alignment.manual', editorKey: editor.editorKey });
    state.connectionError = undefined;
    expect(flow.observe(state).editorKey).toBe(editor.editorKey);
    state.library!.clock = undefined; flow.complete();
    expect(flow.observe(state).state).toBe('ready');
  });
  it.each([true, false])('falls directly back to stable manual timing when clock detection fails (connected: %s)', connected => {
    const flow = new GuidedWorkflow(), state = facts(connected); recording(state);
    if (!connected) flow.send('prepare', state);
    state.library!.clock = { status: 'running', framesRead: 0, message: 'Reading' };
    expect(flow.observe(state)).toMatchObject({ state: 'alignment.analyzing', primary: undefined });
    state.library!.clock = { status: 'needs-attention', message: 'Clock hidden', framesRead: 4 };
    const editor = flow.observe(state);
    expect(editor).toMatchObject({ state: 'alignment.manual', primary: 'Done' });
    state.library!.clock = undefined; state.connectionError = 'Disconnected';
    expect(flow.observe(state)).toMatchObject({ state: 'alignment.manual', editorKey: editor.editorKey });
    state.connectionError = undefined;
    align(state); flow.complete();
    expect(flow.observe(state).state).toBe(connected ? 'ready' : 'ready.offline');
  });
  it('can retry automatic detection from manual timing and requires Start after success', () => {
    const flow = new GuidedWorkflow(), state = facts(); recording(state); align(state);
    flow.send('edit', state); flow.observe(state);
    flow.complete(); state.library!.clock = { status: 'running', framesRead: 0, message: 'Reading' };
    expect(flow.observe(state)).toMatchObject({ state: 'alignment.analyzing', primary: undefined });
    state.library!.clock = { status: 'accepted', offsetSeconds: 18, framesRead: 12, message: 'Aligned' };
    expect(flow.observe(state)).toMatchObject({ state: 'ready', primary: 'Start listening' });
  });
  it('allows offline preparation, then requires connection and explicit Start', () => {
    const flow = new GuidedWorkflow(), state = facts(false);
    flow.send('prepare', state); expect(flow.observe(state).state).toBe('recording.choose');
    recording(state); align(state); expect(flow.observe(state).state).toBe('ready.offline');
    flow.send('review', state); expect(flow.observe(state).state).toBe('setup.folder');
    state.replay = facts().replay; expect(flow.observe(state).state).toBe('ready');
  });
  it.each([true, false])('finishes live edits while preserving listening or offline preparation (connected: %s)', connected => {
    const flow = new GuidedWorkflow(), state = facts(connected); recording(state); align(state);
    if (!connected) flow.send('prepare', state);
    flow.observe(state); flow.send('edit', state);
    state.library!.boundToRuntime = connected; state.sync.state = 'following';
    const editor = flow.observe(state);
    align(state);
    expect(flow.observe(state)).toMatchObject({ state: 'alignment.manual', editorKey: editor.editorKey });
    flow.send('finish-edit', state);
    expect(flow.observe(state).state).toBe(connected ? 'listening' : 'ready.offline');
  });
  it('resets the editor for a different recording but retains it for progress updates', () => {
    const flow = new GuidedWorkflow(), state = facts(); recording(state);
    const first = flow.observe(state);
    state.library!.recording!.progress = 0.9;
    expect(flow.observe(state).editorKey).toBe(first.editorKey);
    state.library!.mediaGeneration++;
    const second = flow.observe(state);
    expect(second.editorKey).toBeGreaterThan(first.editorKey);
    expect(second.state).toBe('alignment.manual');
  });
  it('requires explicit track choice and a trustworthy range before starting', () => {
    const flow = new GuidedWorkflow(), state = facts(); recording(state); align(state);
    state.library!.trackChosen = false; expect(flow.observe(state).state).toBe('recording.track');
    state.library!.trackChosen = true; state.media!.tracks[0]!.range = undefined;
    state.library!.timingAnalysis = 'running'; expect(flow.observe(state).state).toBe('recording.timing');
    state.library!.timingAnalysis = 'failed'; expect(flow.observe(state).state).toBe('recording.timing-error');
  });
  it('chooses another recording deliberately and offers a return until a new file is opened', () => {
    const flow = new GuidedWorkflow(), state = facts(); recording(state); align(state); flow.observe(state);
    flow.send('change-recording', state);
    expect(flow.observe(state)).toMatchObject({ state: 'recording.choose', canReturn: true });
    flow.send('review', state); expect(flow.observe(state).state).toBe('ready');
    state.library!.recordingReady = false; state.library!.missingRecording = true;
    expect(flow.observe(state).state).toBe('recording.locate');
  });
});
