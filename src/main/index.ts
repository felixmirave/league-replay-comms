import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell, utilityProcess, type UtilityProcess } from 'electron';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { initialSnapshot, userCommandSchema, type ProbeSnapshot, type WorkerRequest, type WorkerResponse } from '../shared/protocol';
import { ReviewLibrary } from '../library/library';
import { HashWorkers } from '../analysis/hash-client';
import { ReviewSession } from './review-session';
import { Ffprobe } from '../analysis/probe';
import { DecoderQueue } from '../analysis/decoder-client';
import { PreviewSession } from './preview-session';
import { AnalysisCache } from '../library/analysis-cache';
import { OcrReader } from '../analysis/ocr-client';
import { VideoClockAnalyzer } from '../analysis/video-clock';
import { CachedClockAnalysis } from '../analysis/cached-clock';
import { ClockCache } from '../library/clock-cache';
import { clockRuntimeId } from '../analysis/runtime-id';
import { QuitCoordinator } from './quit';
import { LeagueSetup } from './league-setup';
import { WindowsLeagueDiscovery } from '../platform/discovery';
import { WindowsConfigEdits } from '../platform/config-edit';
import { PreferenceEdits } from './preference-edits';
import { diagnosticExport } from './diagnostics';
import { GuidedWorkflow } from './workflow';

app.setName('LeagueReplayComms');
// Apply an explicit profile before the instance lock or any durable writes.
// Packaged validation uses the same switch instead of enabling development hooks.
const explicitProfile = app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : undefined;
const profile = explicitProfile ?? (!app.isPackaged ? process.env.COMMS_TEST_USER_DATA : undefined);
if (profile !== undefined) {
  if (!isAbsolute(profile)) throw new Error('--user-data-dir must name an absolute directory');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}
if (!app.requestSingleInstanceLock()) app.exit(0);
let window: BrowserWindow | undefined;
let worker: UtilityProcess | undefined;
let snapshot: ProbeSnapshot = structuredClone(initialSnapshot);
let sequence = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let review: ReviewSession | undefined;
let hashes: HashWorkers | undefined;
let library: ReviewLibrary | undefined;
let previews: PreviewSession | undefined;
let decoders: DecoderQueue | undefined;
let clockReader: OcrReader | undefined;
let clockAnalysis: CachedClockAnalysis | undefined;
let commands = Promise.resolve();
let startupError: string | undefined;
let startup: NonNullable<ProbeSnapshot['startup']> = 'loading';
let preparingExit = false;
const workflow = new GuidedWorkflow();
let foregroundBusy = false;
let setup: LeagueSetup | undefined;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

function request(command: Exclude<WorkerRequest, { type: 'heartbeat' | 'power' }>['command']): Promise<unknown> {
  // Previously accepted commands still drain, but closing must not restart audio.
  if (preparingExit && (command.type === 'follow' || (command.type === 'preview' && !command.paused))) command = { type: 'preview', paused: true };
  if (!worker) return Promise.reject(new Error('Playback process is unavailable. Restart the application.'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeoutMs = command.type === 'load' || command.type === 'retry' ? 30_000 : 10_000;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Playback operation timed out')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker!.postMessage({ id, command });
  });
}

function verifySender(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unexpected message sender');
}

function publishedSnapshot(): ProbeSnapshot {
  const value = { ...snapshot, startup, busy: startup === 'loading' || preparingExit || foregroundBusy || snapshot.busy, error: startupError ?? snapshot.error, library: review?.snapshot(), setup: setup?.snapshot() };
  return { ...value, workflow: workflow.observe(value) };
}
function publish(): void { if (window && !window.isDestroyed()) window.webContents.send('review:snapshot', publishedSnapshot()); }
function publishPreview(): void { if (window && !window.isDestroyed() && previews) window.webContents.send('review:preview', previews.snapshot()); }

app.on('second-instance', () => { window?.restore(); window?.focus(); });
async function initialize(resources: string): Promise<void> {
  const testOutput = !app.isPackaged && process.env.COMMS_TEST_NULL_AUDIO === '1' ? '--test-null-audio' : '';
  worker = utilityProcess.fork(join(__dirname, '../sync/entry.cjs'), [resources, testOutput], { serviceName: 'Replay comms synchronization', stdio: 'pipe' });
  worker.on('message', (message: WorkerResponse) => {
    if (message.type === 'snapshot') {
      snapshot = message.snapshot;
      review?.onPlayback(snapshot);
      publish();
    } else {
      const call = pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error)); else call.resolve(message.data);
    }
  });
  worker.stderr?.on('data', data => { process.stderr.write(data); });
  worker.on('exit', code => {
    worker = undefined;
    clearInterval(heartbeat);
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Playback process stopped')); }
    pending.clear();
    snapshot = { ...snapshot, error: `Playback process stopped (${code}). Restart the application.`, busy: false };
    publish();
  });
  heartbeat = setInterval(() => worker?.postMessage({ type: 'heartbeat' }), 500);
  let powerSequence = 0;
  const forwardPower = (state: 'suspend' | 'resume') => {
    if (!preparingExit) worker?.postMessage({ type: 'power', state, sequence: ++powerSequence });
  };
  powerMonitor.on('suspend', () => forwardPower('suspend'));
  powerMonitor.on('resume', () => forwardPower('resume'));

  library = await ReviewLibrary.open(app.getPath('userData'));
  if (preparingExit) return;
  const preferences = new PreferenceEdits(library);
  const configEdits = new WindowsConfigEdits(join(resources, 'scripts'), join(app.getPath('userData'), 'config-operations'), !app.isPackaged ? process.env.COMMS_TEST_POWERSHELL : undefined);
  setup = new LeagueSetup(new WindowsLeagueDiscovery(join(resources, 'scripts', 'discover-league.ps1')), library, publish, undefined, configEdits, preferences);
  void setup.refresh().catch(error => { startupError = error instanceof Error ? error.message : String(error); publish(); });
  hashes = new HashWorkers(join(__dirname, '../analysis/hash-entry.cjs'));
  const decoderPath = join(resources, 'bin', process.platform === 'win32' ? 'win32-x64/ffmpeg.exe' : 'linux-x64/ffmpeg');
  decoders = new DecoderQueue(join(__dirname, '../analysis/decoder-entry.cjs'), decoderPath);
  previews = new PreviewSession(decoders, new AnalysisCache(join(app.getPath('userData'), 'cache', 'waveforms')), publishPreview);
  clockReader = new OcrReader(join(__dirname, '../analysis/ocr-entry.cjs'), join(resources, 'ocr'));
  const runtimeId = await clockRuntimeId(resources, decoderPath);
  if (preparingExit) return;
  clockAnalysis = new CachedClockAnalysis(new VideoClockAnalyzer(decoders, clockReader), new ClockCache(join(app.getPath('userData'), 'cache', 'clocks'), runtimeId));
  review = new ReviewSession(library, hashes, {
    snapshot: () => snapshot,
    send: async command => {
      const state = await request(command) as ProbeSnapshot;
      snapshot = state;
      publish();
      return state;
    },
  }, publish, new Ffprobe(join(resources, 'bin', process.platform === 'win32' ? 'win32-x64/ffprobe.exe' : 'linux-x64/ffprobe')), previews, clockAnalysis, preferences);
}

const startupTask = app.whenReady().then(async () => {
  if (preparingExit) return;
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');

  window = new BrowserWindow({ show: false, width: 780, height: 820, minWidth: 560, minHeight: 640, backgroundColor: '#f2f4f8',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const shown = new Promise<void>(resolve => window!.once('ready-to-show', () => {
    if (!preparingExit) window!.show();
    resolve();
  }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { event.preventDefault(); void quit.request(); });

  ipcMain.handle('review:snapshot', event => { verifySender(event); return publishedSnapshot(); });
  ipcMain.handle('review:preview', event => { verifySender(event); return previews?.snapshot() ?? { revision: 0, mediaGeneration: 0 }; });
  ipcMain.handle('review:command', (event, raw: unknown) => {
    verifySender(event);
    if (preparingExit) throw new Error('The application is saving before closing. Cancel closing to keep reviewing.');
    if (startup === 'loading') throw new Error('The application is still starting. Please wait.');
    const command = userCommandSchema.parse(raw);
    const operation = commands.then(async () => {
    const opening = ['open-path', 'select-recording', 'locate-media'].includes(command.type);
    if (opening) { foregroundBusy = true; publish(); }
    try {
    if (command.type === 'open-notices') {
      const error = await shell.openPath(join(resources, 'notices', 'THIRD_PARTY_NOTICES.html'));
      if (error) throw new Error(`Could not open dependency notices: ${error}`);
      return;
    }
    if (!review) throw new Error('The saved library is unavailable. Resolve the library error and restart the application.');
    if (command.type === 'workflow') {
      workflow.send(command.action, publishedSnapshot());
      if (command.action === 'edit' || command.action === 'cancel-edit') await review.enterTiming();
      else if (command.action !== 'prepare' && snapshot.media) await review.stop();
      publish();
    } else if (command.type === 'stop') { await review.stop(); workflow.complete(); publish(); }
    else if (command.type === 'setup-refresh') await setup?.refresh();
    else if (command.type === 'setup-enable') await setup?.enable(command.path);
    else if (command.type === 'setup-restore') await setup?.restore(command.path, command.backupId);
    else if (command.type === 'setup-elevate') await setup?.approveElevation();
    else if (command.type === 'setup-choose-folder') {
      const selected = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: 'Choose the League of Legends installation folder' });
      if (!selected.canceled && selected.filePaths[0]) await setup?.select(selected.filePaths[0]);
    } else if (command.type === 'setup-select') {
      if (!setup?.snapshot().installations.some(installation => installation.root === command.root)) throw new Error('Choose one of the detected installations or select its folder.');
      await setup.select(command.root);
    } else if (command.type === 'setup-open-config') {
      const view = setup?.snapshot(), selected = view?.installations.find(installation => installation.root === view.selectedRoot);
      if (!selected?.configs.some(config => config.path === command.path)) throw new Error('Select an installation before opening its config folder.');
      const error = await shell.openPath(dirname(command.path));
      if (error) throw new Error(error);
    } else if (command.type === 'open') {
      const selected = await dialog.showOpenDialog(window!, { properties: ['openFile'], title: 'Choose a comms recording',
        filters: [{ name: 'Audio and video', extensions: ['mp4', 'mkv', 'mov', 'webm', 'wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }, { name: 'All files', extensions: ['*'] }] });
      if (!selected.canceled && selected.filePaths[0]) { workflow.complete(); await review.openMedia(selected.filePaths[0]); }
    } else if (command.type === 'open-path') {
      if (!isAbsolute(command.path)) throw new Error('Drop a file from this computer.');
      workflow.complete(); await review.openMedia(command.path);
    } else if (command.type === 'select-recording') { workflow.complete(); await review.selectRecording(command.id); }
    else if (command.type === 'align') { await review.setManualOffset(command.offsetSeconds, command.correctionSeconds); workflow.complete(); publish(); }
    else if (command.type === 'align-here') { await review.alignHere(); workflow.complete(); publish(); }
    else if (command.type === 'nudge') await review.nudge(command.deltaSeconds);
    else if (command.type === 'track') { await review.selectTrack(command.trackId); workflow.complete(); publish(); }
    else if (command.type === 'preview-track') { await review.selectTrack(command.trackId, false); await request({ type: 'preview', paused: false }); }
    else if (command.type === 'volume') await review.setVolume(command.volume);
    else if (command.type === 'follow') {
      if (publishedSnapshot().workflow?.state !== 'ready') throw new Error('Finish the current step before listening.');
      await review.follow(); publish();
    }
    else if (command.type === 'retry-save') await review.retrySave();
    else if (command.type === 'seek-preview') await review.seekPreview(command.positionSeconds);
    else if (command.type === 'preview-frame') {
      await request({ type: 'preview', paused: true });
      previews?.showFrame(command.positionSeconds);
    } else if (command.type === 'preview-video') {
      await request({ type: 'preview', paused: true }); await review.selectClockRegion(command.streamIndex);
    } else if (command.type === 'preview-crop') {
      const stream = previews?.snapshot().videoStreamIndex;
      if (stream === undefined) throw new Error('Open a video recording first');
      await request({ type: 'preview', paused: true }); await review.selectClockRegion(stream, command.crop);
    } else if (command.type === 'analyze-clock') {
      const preview = previews?.snapshot();
      if (preview?.videoStreamIndex === undefined) throw new Error('Open a video recording first');
      await request({ type: 'preview', paused: true });
      workflow.complete(); await review.analyzeVideo(preview.videoStreamIndex, preview.crop);
    } else if (command.type === 'cancel-clock') {
      workflow.send('edit', publishedSnapshot()); await review.enterTiming(); publish();
    } else if (command.type === 'waveform-window') previews?.waveformWindow(command.startSeconds, command.endSeconds);
    else if (command.type === 'add-media-folder') {
      const selected = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: 'Choose a folder to search for moved recordings' });
      if (!selected.canceled && selected.filePaths[0]) await review.addFolder(selected.filePaths[0]);
    } else if (command.type === 'locate-media') {
      const selected = await dialog.showOpenDialog(window!, { properties: ['openFile'], title: 'Locate the original recording' });
      if (!selected.canceled && selected.filePaths[0]) await review.locateMedia(selected.filePaths[0]);
    } else if (command.type === 'export-trace') {
      const selected = await dialog.showSaveDialog(window!, { defaultPath: 'replay-comms-trace.json', filters: [{ name: 'Timing trace', extensions: ['json'] }] });
      if (!selected.canceled && selected.filePath) {
        const trace = await request({ type: 'trace' });
        const includePaths = command.includePaths === true;
        const selectedReview = review.snapshot();
        const data = { schemaVersion: 2, appVersion: app.getVersion(), platform: process.platform, architecture: process.arch,
          electronVersion: process.versions.electron, nodeVersion: process.versions.node, exportedAt: new Date().toISOString(), includePaths,
          selection: { mediaHash: selectedReview.recording?.hash, boundToRuntime: selectedReview.boundToRuntime, workflow: publishedSnapshot().workflow?.state }, trace };
        await writeFile(selected.filePath, JSON.stringify(diagnosticExport(data, includePaths, [app.getPath('userData'), app.getAppPath(), selectedReview.recording?.path ?? '']), null, 2));
      }
    } else await request(command);
    } finally { foregroundBusy = false; publish(); }
    });
    commands = operation.catch(() => undefined);
    return operation;
  });
  // Paint the loading screen before library I/O or service initialization begins.
  await Promise.all([window.loadFile(join(__dirname, '../renderer/index.html')), shown]);
  if (preparingExit) return;
  await initialize(resources);
  if (!preparingExit) startup = 'ready';
}).catch(error => {
  startup = 'failed';
  startupError = error instanceof Error ? error.message : String(error);
}).finally(publish);

const quit = new QuitCoordinator({
  freeze: value => { preparingExit = value; publish(); },
  // Initialization may be awaiting I/O when the early window is closed. Let it
  // reach an exit guard before disposing services, so none can start after exit.
  drain: async () => { await startupTask; await commands; },
  silence: async () => {
    // A failed player must not prevent saving. Killing the owned utility stops
    // its heartbeat; mpv's independent watchdog then terminates output.
    if (worker && snapshot.media) await request({ type: 'preview', paused: true }).catch(() => { worker?.kill(); });
  },
  prepare: async () => { await review?.prepareExit(); },
  retry: async () => { await review?.retryExitSave(); },
  unsaved: () => review?.snapshot().saveError,
  decide: async message => {
    const options: Electron.MessageBoxOptions = { type: 'warning', title: 'Unsaved review changes', message: 'Some review changes have not been saved.',
      detail: `${message}\n\nCancel to keep reviewing without losing your unsaved timing changes.`, buttons: ['Retry saving', 'Cancel', 'Discard changes and quit'], defaultId: 0, cancelId: 1, noLink: true };
    const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return result.response === 0 ? 'retry' : result.response === 2 ? 'discard' : 'cancel';
  },
  resume: () => review?.resumeAfterExit(),
  failed: error => { startupError = `Could not finish closing: ${error instanceof Error ? error.message : String(error)}`; publish(); },
  finish: async () => {
    // Durable edits have been saved or explicitly discarded before any deadline.
    review?.close(); previews?.close(); setup?.close(); clearInterval(heartbeat);
    const fallback = setTimeout(() => { worker?.kill(); app.exit(); }, 2500);
    await Promise.allSettled([request({ type: 'close' }), hashes?.close(), decoders?.close(), clockReader?.close(), clockAnalysis?.flush(), previews?.settled(), library?.flush()]);
    clearTimeout(fallback); app.exit();
  },
});
app.on('before-quit', event => { event.preventDefault(); void quit.request(); });
app.on('window-all-closed', () => app.quit());
