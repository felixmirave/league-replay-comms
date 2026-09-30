import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initialSnapshot, type DesktopInterface, type ProbeSnapshot, type UserCommand } from '../shared/protocol';
import type { PreviewView } from '../shared/analysis';
import type { WorkflowState } from '../shared/workflow';
import { RecordingPreview } from './preview';
import { SetupPanel } from './setup';
import { TimingEditor, time } from './timing-editor';
import './style.css';

declare global { interface Window { review: DesktopInterface } }
const titles: Record<WorkflowState, string> = {
  checking: 'Checking League…', 'setup.folder': 'Where is League installed?', 'setup.installation': 'Choose your League installation',
  'setup.enable': 'Allow replay connection', 'setup.permission': 'Windows permission is needed', 'setup.editing': 'Updating replay connection…', 'setup.repair': 'Check League’s configuration',
  'replay.wait': 'Open a replay in League', 'recording.choose': 'Choose your recording', 'recording.opening': 'Opening recording…', 'recording.identifying': 'Restoring saved timing…',
  'recording.locate': 'Find your saved recording', 'recording.track': 'Which track has the comms?', 'recording.timing': 'Reading audio timing…', 'recording.timing-error': 'This track’s timing is unavailable',
  'alignment.analyzing': 'Finding the game clock…', 'alignment.crop': 'Show us the game clock', 'alignment.manual': 'Match one moment',
  ready: 'Ready to listen', 'ready.offline': 'Your timing is ready', listening: 'Following League', 'audio.error': 'Audio could not start', 'application.error': 'The application could not start',
};
const descriptions: Record<WorkflowState, string> = {
  checking: 'Finding the installation and checking replay access.', 'setup.folder': 'Choose the League of Legends game folder so we can check replay access.',
  'setup.installation': 'More than one installation was found. Choose the one you use.',
  'setup.enable': 'This lets the app read your replay’s time. We’ll back up League’s configuration before changing it.',
  'setup.permission': 'Only the configuration helper needs Windows permission to update the replay setting.', 'setup.editing': 'Please wait while the configuration is updated and checked.',
  'setup.repair': 'The replay setting could not be checked safely. Review the details below, then check again.',
  'replay.wait': 'Open a replay in the League client. We’ll connect automatically when it opens.',
  'recording.choose': 'Select the audio or video containing your team’s comms, or drop it here.',
  'recording.opening': 'Reading the file and restoring any saved track and timing.', 'recording.identifying': 'Checking whether this recording already has saved timing. You can start aligning manually while this finishes.', 'recording.locate': 'Locate the original recording to restore its timing, even if the file was renamed.',
  'recording.track': 'Preview a track, then choose the one you want to hear.', 'recording.timing': 'Determining when the audio starts and ends. Your alignment is kept.',
  'recording.timing-error': 'Choose another track or recording. You can still preview this track and adjust its timing.',
  'alignment.analyzing': 'Reading the timer in the video to line up the comms.', 'alignment.crop': 'Select the timer’s area in a clear recording frame, or align manually.',
  'alignment.manual': 'Find the same moment in League and in your recording. Following is paused while you adjust timing.',
  ready: 'Comms will follow playback, pauses, speed changes, and jumps in League.',
  'ready.offline': 'Your recording and timing are saved locally when identification finishes. Connect to League before listening.',
  listening: 'Control playback in League. You can leave this window in the background.', 'audio.error': 'Your recording and timing are kept. Check your audio output, then try again.',
  'application.error': 'Close and reopen the application after resolving the problem below.',
};
function App() {
  const [snapshot, setSnapshot] = useState<ProbeSnapshot>(initialSnapshot);
  const [preview, setPreview] = useState<PreviewView>({ revision: 0, mediaGeneration: 0 });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [includePaths, setIncludePaths] = useState(false);
  const [selectedRoot, setSelectedRoot] = useState('');
  const [track, setTrack] = useState<number>();
  const heading = useRef<HTMLHeadingElement>(null), settingsDialog = useRef<HTMLDialogElement>(null);
  const flow = snapshot.workflow, state = flow?.state ?? 'checking', library = snapshot.library;
  const connected = !!snapshot.replay && !snapshot.connectionError;
  const busy = snapshot.busy || pending > 0;
  const installation = snapshot.setup?.installations.find(value => value.root === snapshot.setup?.selectedRoot);
  const config = installation?.configs.length === 1 ? installation.configs[0] : undefined;
  const editing = state === 'alignment.manual';
  const setupState = state.startsWith('setup.');
  const title = state === 'listening' ? (({ paused: 'Replay paused', recovering: 'Catching up with League…', 'outside-recording': 'Outside the recording', 'unsupported-speed': 'Choose a supported replay speed' } as Partial<Record<string, string>>)[snapshot.sync.state] ?? titles.listening) : titles[state];
  useEffect(() => {
    const a = window.review.subscribe(setSnapshot), b = window.review.subscribePreview(value => setPreview(previous => value.revision >= previous.revision ? value : previous));
    void window.review.snapshot().then(setSnapshot).catch(error => setError(String(error)));
    void window.review.preview().then(setPreview).catch(error => setError(String(error)));
    return () => { a(); b(); };
  }, []);
  useEffect(() => {
    if (!settings && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) heading.current?.focus();
    setError('');
  }, [state]);
  useEffect(() => { setTrack(snapshot.media?.selectedTrackId); }, [library?.mediaGeneration, snapshot.media?.selectedTrackId]);
  useEffect(() => { if (settings) settingsDialog.current?.showModal(); else settingsDialog.current?.close(); }, [settings]);
  const command = async (value: UserCommand) => {
    setError(''); setPending(count => count + 1);
    try { await window.review.command(value); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(count => count - 1); }
  };
  const primary = () => {
    const commands: Partial<Record<WorkflowState, UserCommand>> = {
      'setup.folder': { type: 'setup-choose-folder' }, 'setup.installation': { type: 'setup-select', root: selectedRoot },
      'setup.enable': { type: 'setup-enable', path: config?.path ?? '' }, 'setup.permission': { type: 'setup-elevate' }, 'setup.repair': { type: 'setup-refresh' },
      'recording.choose': { type: 'open' }, 'recording.locate': { type: 'locate-media' }, 'recording.track': { type: 'track', trackId: track ?? snapshot.media?.selectedTrackId ?? 1 },
      'recording.timing-error': { type: 'workflow', action: (snapshot.media?.tracks.length ?? 0) > 1 ? 'change-track' : 'change-recording' }, 'alignment.crop': { type: 'analyze-clock' }, ready: { type: 'follow' },
      'ready.offline': { type: 'workflow', action: 'review' }, listening: { type: 'stop' }, 'audio.error': { type: 'retry' },
    };
    if (state === 'setup.installation' && !selectedRoot) { setError('Choose the installation you use.'); return; }
    if (commands[state]) void command(commands[state]!);
  };
  const drop = async (event: React.DragEvent) => {
    event.preventDefault();
    if (state !== 'recording.choose' || busy) return;
    const file = event.dataTransfer.files[0]; if (!file) return;
    setPending(count => count + 1); setError('');
    try { await window.review.openDropped(file); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(count => count - 1); }
  };
  const visibleError = error || (setupState ? snapshot.setup?.error : library?.error) || snapshot.error || snapshot.audioOutput?.error;
  return <main>
    <header><strong>League Replay Comms</strong><button className="text-button" onClick={() => setSettings(true)}>Settings</button></header>
    <div className="context"><span>{connected ? 'League connected' : 'League not connected'}</span>{library?.recording && <span className="filename" title={library.recording.path}>{library.recording.path.split(/[\\/]/).at(-1)}</span>}
      {library?.saveError && <div className="notice" role="status"><strong>Changes not saved.</strong> Your timing stays available in this session. <button className="text-button" disabled={busy} onClick={() => void command({ type: 'retry-save' })}>Retry saving</button><details><summary>Save details</summary><p>{library.saveError}</p></details></div>}
    </div>
    <section className="task" aria-labelledby="task-title" data-state={state} onDragOver={event => { if (state === 'recording.choose') event.preventDefault(); }} onDrop={event => void drop(event)}>
      <h1 id="task-title" ref={heading} tabIndex={-1}>{title}</h1><p className="description">{descriptions[state]}</p>
      <p className="sr-only" role="status" aria-live="polite">{title}</p>
      {visibleError && <div role="alert" className="error">{visibleError}{editing && (snapshot.error || snapshot.audioOutput?.error) && <p><button disabled={busy} onClick={() => void command({ type: 'retry' })}>Retry audio</button></p>}</div>}
      {state === 'setup.installation' && <fieldset><legend>League installation</legend>{snapshot.setup?.installations.map(item => <label className="choice" key={item.root}><input type="radio" name="installation" value={item.root} checked={selectedRoot === item.root} onChange={() => setSelectedRoot(item.root)} />{item.root}</label>)}</fieldset>}
      {state === 'setup.repair' && <><p>{installation?.configs.length !== 1 ? 'Several or no configuration files were found. Select the correct installation or open Settings for manual instructions.' : config?.inspection.state !== 'enabled' && config?.inspection.state !== 'disabled' ? config?.inspection.reason : ''}</p><button className="text-button" onClick={() => void command({ type: 'setup-choose-folder' })}>Choose a different League folder</button></>}
      {state === 'replay.wait' && <><p className="progress">Waiting for the replay viewer…</p>{snapshot.setup?.message && <p>If replay access was just enabled while the viewer was open, close and reopen that replay in League.</p>}<button className="text-button" onClick={() => setHelp(!help)}>Connection help</button>{help && <div className="notice"><p>Open a replay from League’s match history. If it is already open, close and reopen the replay. The app checks for it automatically.</p>{snapshot.connectionError && <details><summary>Connection details</summary><p>{snapshot.connectionError}</p></details>}<button onClick={() => void command({ type: 'setup-refresh' })}>Check setup again</button><button className="text-button" onClick={() => setSettings(true)}>Open connection settings</button></div>}</>}
      {state === 'recording.choose' && !!library?.recordings.length && <div className="recents"><h2>Recent recordings</h2>{library.recordings.slice(0, 8).map(file => <button className="recent" key={file.id} disabled={busy} title={file.path} onClick={() => void command({ type: 'select-recording', id: file.id })}><span>{file.name}</span><small>{file.pending ? 'Identification unfinished' : 'Restore saved track and timing'}</small></button>)}</div>}
      {state === 'recording.track' && <fieldset><legend>Audio tracks</legend>{snapshot.media?.tracks.map(item => <div className="track-choice" key={item.id}><label><input type="radio" name="track" checked={track === item.id} onChange={() => setTrack(item.id)} />{item.title}{item.language ? ` · ${item.language}` : ''}</label><button disabled={busy} onClick={() => void command({ type: 'preview-track', trackId: item.id })}>Preview {item.title}</button></div>)}{!snapshot.paused && <button onClick={() => void command({ type: 'preview', paused: true })}>Pause preview</button>}</fieldset>}
      {(state === 'alignment.analyzing' || state === 'recording.identifying') && <><p className="progress" role="status">{library?.clock?.message ?? 'Identifying the recording before restoring or reading its clock…'}</p>{library?.clock && <p className="muted">{library.clock.framesRead} frames checked</p>}<button className="text-button" onClick={() => void command({ type: 'workflow', action: 'edit' })}>Align manually</button></>}
      {state === 'alignment.crop' && snapshot.media && <><p className="notice">{library?.clock?.message}</p><RecordingPreview mode="crop" preview={preview} media={snapshot.media} position={snapshot.positionSeconds} disabled={busy} command={command} useFrame={() => {}} /></>}
      {editing && snapshot.media && <TimingEditor key={`${library?.mediaGeneration}:${flow?.editorKey}`} snapshot={snapshot} preview={preview} busy={busy} command={command} />}
      {state === 'ready' && <div className="notice"><strong>{snapshot.media?.name}</strong><p>{library?.alignment?.source === 'video-clock' ? 'Timing aligned from the recorded clock.' : 'Your timing is ready.'}</p></div>}
      {state === 'listening' && <><div className="replay-clock" aria-label="Replay time">{time(snapshot.replay?.timeSeconds)} <small>{snapshot.replay?.speed ?? 1}×</small></div>{snapshot.sync.state === 'outside-recording' && <p>This replay position is outside the recorded audio. Comms will resume when the replay returns to the recording.</p>}{snapshot.sync.state === 'unsupported-speed' && <p>Change the replay speed in League. Comms are silent until playback is supported.</p>}<label className="volume">Comms volume<input type="range" min="0" max="100" value={library?.volume ?? 100} onChange={event => void command({ type: 'volume', volume: Number(event.target.value) })} /></label></>}
      {!editing && flow?.primary && <div className="actions"><button className="primary" disabled={busy} onClick={primary}>{flow.primary}</button></div>}
      <div className="secondary">
        {(setupState || state === 'replay.wait') && <button className="text-button" onClick={() => void command({ type: 'workflow', action: 'prepare' })}>Prepare a recording without League</button>}
        {['ready', 'ready.offline', 'listening', 'recording.timing', 'recording.timing-error', 'alignment.crop'].includes(state) && <button className="text-button" onClick={() => void command({ type: 'workflow', action: 'edit' })}>{state === 'alignment.crop' ? 'Align manually' : 'Adjust timing'}</button>}
        {(library?.recordingReady || state === 'recording.locate') && state !== 'recording.choose' && state !== 'recording.opening' && <button className="text-button" onClick={() => void command({ type: 'workflow', action: 'change-recording' })}>Change recording</button>}
        {flow?.canReturn && <button className="text-button" onClick={() => void command({ type: 'workflow', action: 'review' })}>Back to recording</button>}
      </div>
      {library?.recording && !library.recording.hash && library.recordingReady && <div className="hash-progress"><progress aria-label="Recording identification" max="1" value={library.recording.progress} /><span>Remembering this recording. Preview and alignment stay available.</span></div>}
    </section>
    <footer>Local playback · recordings stay on your computer</footer>
    <dialog ref={settingsDialog} onClose={() => setSettings(false)} aria-labelledby="settings-title"><div className="section-title"><h2 id="settings-title">Settings</h2><button onClick={() => setSettings(false)}>Close settings</button></div>
      {error && <div role="alert" className="error">{error}</div>}
      <SetupPanel setup={snapshot.setup} connected={connected} disabled={busy} command={command} />
      {library?.recordingReady && <section><h3>Recording</h3><label className="volume">Comms volume<input type="range" min="0" max="100" value={library.volume} onChange={event => void command({ type: 'volume', volume: Number(event.target.value) })} /></label><button onClick={() => { setSettings(false); void command({ type: 'workflow', action: 'change-track' }); }}>Change audio track</button></section>}
      <section><h3>Recording folders</h3><p>Search these folders if a saved recording moves.</p>{library?.folders.map(path => <p className="filename" key={path}>{path}</p>)}<button onClick={() => void command({ type: 'add-media-folder' })}>Add media folder</button></section>
      <details><summary>Timing diagnostics</summary><p>Physical accuracy has not yet been validated against League.</p><dl><dt>Controller</dt><dd>{snapshot.sync.state}</dd><dt>Connection</dt><dd>{snapshot.connectionError ?? (connected ? 'Connected' : 'Waiting')}</dd><dt>Output driver</dt><dd>{snapshot.audioOutput?.driver ?? 'Unavailable'}</dd><dt>Offset</dt><dd>{snapshot.offsetSeconds?.toFixed(3) ?? 'Unset'} s</dd><dt>Estimated error</dt><dd>{snapshot.sync.errorSeconds === undefined ? '—' : `${(snapshot.sync.errorSeconds * 1000).toFixed(1)} ms`}</dd></dl><label className="checkbox"><input type="checkbox" checked={includePaths} onChange={event => setIncludePaths(event.target.checked)} />Include local file paths in exported trace</label><button onClick={() => void command({ type: 'export-trace', includePaths })}>Export timing trace</button><button onClick={() => void command({ type: 'retry' })}>Retry audio</button></details>
      {!!library?.warnings.length && <section><h3>Library notices</h3>{library.warnings.map(value => <p key={value}>{value}</p>)}</section>}
      <p><button className="text-button" onClick={() => void command({ type: 'open-notices' })}>Third-party notices</button></p>
    </dialog>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
