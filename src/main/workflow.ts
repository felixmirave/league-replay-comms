import type { ProbeSnapshot } from '../shared/protocol';
import type { WorkflowIntent, WorkflowState, WorkflowView } from '../shared/workflow';

type Mode = 'review' | 'edit' | 'choose' | 'track';
interface Context { mode: Mode; prepare: boolean; sawConnection: boolean; mediaKey?: string; state: WorkflowState; revision: number; editorKey: number }
const initial = (): Context => ({ mode: 'review', prepare: false, sawConnection: false, state: 'checking', revision: 0, editorKey: 0 });
const primary: Partial<Record<WorkflowState, string>> = {
  'setup.folder': 'Choose League folder', 'setup.installation': 'Use this installation', 'setup.enable': 'Enable replay connection',
  'setup.permission': 'Allow Windows permission', 'setup.repair': 'Check configuration again',
  'recording.choose': 'Choose recording', 'recording.locate': 'Locate recording', 'recording.track': 'Use this track',
  'recording.timing-error': 'Choose another track', 'alignment.manual': 'Done',
  ready: 'Start listening', 'ready.offline': 'Connect to League', listening: 'Stop listening', 'audio.error': 'Retry audio',
};
function route(context: Context, facts: ProbeSnapshot): WorkflowState {
  if (facts.startup === 'loading') return 'starting';
  if (facts.startup === 'failed') return 'application.error';
  const library = facts.library, setup = facts.setup, connected = !!facts.replay && !facts.connectionError;
  if (!library) return facts.error ? 'application.error' : 'checking';
  if (context.mode === 'edit' && library.recordingReady) return 'alignment.manual';
  if (context.mode === 'choose') return library.locating || facts.busy ? 'recording.opening' : 'recording.choose';
  if (!context.prepare && !connected) {
    const installation = setup?.installations.find(item => item.root === setup.selectedRoot);
    if (setup?.editing) return 'setup.editing';
    if (setup?.needsElevation) return 'setup.permission';
    if (setup?.searching && !context.sawConnection) return 'checking';
    if (!installation && !context.sawConnection) return setup?.installations.length ? 'setup.installation' : 'setup.folder';
    if (installation) {
      if (installation.configs.length !== 1) return 'setup.repair';
      const config = installation.configs[0]!;
      if (config.inspection.state === 'disabled') return 'setup.enable';
      if (config.inspection.state !== 'enabled') return 'setup.repair';
    }
    return 'replay.wait';
  }
  if (library.locating || facts.busy) return 'recording.opening';
  if (library.missingRecording) return 'recording.locate';
  if (!library.recordingReady || !facts.media) return 'recording.choose';
  if (!library.trackChosen || context.mode === 'track') return 'recording.track';
  if (facts.error || facts.audioOutput?.error || facts.sync.state === 'error') return 'audio.error';
  if (library.alignmentConflict) return 'alignment.manual';
  if (!library.recording?.hash && !library.error && !library.alignment) return 'recording.identifying';
  if (library.clock?.status === 'needs-attention') return 'alignment.manual';
  if (library.clock?.status === 'running') return 'alignment.analyzing';
  if (!library.alignment) {
    if (!library.error && facts.media.originSeconds !== undefined && facts.media.probe?.streams.some(stream => stream.type === 'video')) return 'alignment.analyzing';
    return 'alignment.manual';
  }
  const range = facts.media.tracks.find(track => track.id === facts.media!.selectedTrackId)?.range;
  if (!range) return library.timingAnalysis === 'running' ? 'recording.timing' : 'recording.timing-error';
  if (!connected) return 'ready.offline';
  return library.boundToRuntime && facts.sync.state !== 'preview' ? 'listening' : 'ready';
}

/** One task from authoritative facts; deliberate editing is pinned through background updates. */
export class GuidedWorkflow {
  private context = initial();
  observe(facts: ProbeSnapshot): WorkflowView {
    const previous = this.context, context = { ...previous };
    const mediaKey = facts.library?.recordingReady ? `${facts.library.mediaGeneration}:${facts.media?.selectedTrackId}` : undefined;
    if (mediaKey !== context.mediaKey && mediaKey !== undefined) {
      context.mode = 'review'; context.mediaKey = mediaKey;
    }
    if (facts.replay && !facts.connectionError) context.sawConnection = true;
    const next = route(context, facts);
    if (next !== context.state) context.revision++;
    if (next === 'alignment.manual' && (next !== previous.state || mediaKey !== previous.mediaKey)) {
      context.mode = 'edit'; context.editorKey++;
    }
    context.state = next; this.context = context;
    return { state: next, revision: context.revision, editorKey: context.editorKey,
      canReturn: context.mode === 'choose' && !!facts.library?.recordingReady,
      primary: next === 'recording.timing-error' && (facts.media?.tracks.length ?? 0) < 2 ? 'Choose another recording' : primary[next] };
  }
  send(intent: WorkflowIntent, facts: ProbeSnapshot): void {
    const context = this.context;
    if (intent === 'prepare') context.prepare = true;
    else if (intent === 'finish-edit') context.mode = 'review';
    else if (intent === 'review') context.mode = 'review', context.prepare = false;
    else if (intent === 'change-recording') context.mode = 'choose';
    else {
      if (!facts.library?.recordingReady) throw new Error('Choose a recording first.');
      if (intent === 'change-track') context.mode = 'track';
      else {
        context.mode = 'edit'; context.state = 'alignment.manual'; context.editorKey++;
      }
    }
  }
  complete(): void { this.context.mode = 'review'; }
}
