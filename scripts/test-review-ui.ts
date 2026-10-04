import type { LibraryData } from '../src/library/model';
import type { Page, ElectronApplication } from 'playwright-core';
import type { ProbeSnapshot } from '../src/shared/protocol';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import executablePath from './electron-executable.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

interface TraceReport {
  schemaVersion: number; includePaths: boolean;
  selection: { mediaHash: string; boundToRuntime: boolean };
  trace: {
    clock: string; context: { controllerConfig: { freshnessSeconds: number }; media: { selectedTrackId: number }; offsetSeconds: number };
    entries: { event: string; data: { status?: { state: string }; positionSeconds?: number; type?: string; path?: string } }[];
    retention: { retainedBytes: number; maxBytes: number };
  };
}

// Uses the real Electron main/preload/renderer, disk library, hash worker, and mpv.
// Muted Web Audio and a generated recording make this a workflow test, not an audible timing gate.
const folder = await mkdtemp(join(tmpdir(), 'comms-review-ui-'));
const profile = join(folder, 'profile');
await mkdir(profile);
let mediaPath = join(folder, 'original comms.wav');
const rate = 48000, count = rate * 8;
const wav = Buffer.alloc(44 + count * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 1000), 44 + i * 2);
await writeFile(mediaPath, wav);
let app: ElectronApplication | undefined;
const errors: string[] = [];
async function waitState(window: Page, predicate: (state: ProbeSnapshot) => unknown, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let state;
  do {
    state = await window.evaluate(() => globalThis.window.review.snapshot());
    if (predicate(state)) return state;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Review state did not converge: ${JSON.stringify(state)}`);
}
async function launch() {
  app = await electron.launch({ executablePath, args: ['.', ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])], env: { ...process.env, COMMS_TEST_USER_DATA: profile, COMMS_TEST_NULL_AUDIO: '1' } });
  const window = await app.firstWindow();
  window.setDefaultTimeout(10000);
  window.on('pageerror', error => errors.push(error.message));
  await window.locator('#task-title').waitFor();
  await waitState(window, state => !!state.library);
  return window;
}
async function selectFile(path: string) {
  await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog; }, path);
}
async function close() { await app!.close(); app = undefined; }
async function checkVolumeLayout(window: Page) {
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.evaluate(() => {
    globalThis.window.volumeLayout = { frames: [], raf: 0 };
    const sample = () => {
      globalThis.window.volumeLayout!.frames.push({ top: document.querySelector('.task')!.getBoundingClientRect().top, warning: !!document.querySelector('.context .notice') });
      globalThis.window.volumeLayout!.raf = requestAnimationFrame(sample);
    };
    sample();
  });
  try {
    const slider = window.getByRole('dialog').getByRole('slider', { name: 'Comms volume' });
    const box = await slider.boundingBox();
    assert(box, 'Volume slider has no layout');
    await window.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
    await window.mouse.down();
    try {
      for (let i = 0; i < 60; i++) {
        await window.mouse.move(box.x + 8 + (box.width - 16) * (0.5 + 0.45 * Math.cos(i / 10)), box.y + box.height / 2);
        await delay(12);
      }
    } finally { await window.mouse.up(); }
    const volume = Number(await slider.inputValue());
    await waitState(window, state => state.library?.volume === volume && state.library.unsavedPreferences === 0);
    const frames = await window.evaluate(() => globalThis.window.volumeLayout!.frames);
    assert(frames.length > 1);
    assert(frames.every(frame => !frame.warning && frame.top === frames[0]!.top), 'Dragging volume must not flash a save warning or shift the page');
    assert.equal(JSON.parse(await readFile(join(profile, 'library.json'), 'utf8')).settings.volume, volume);
    console.log(`Real Electron volume: ${frames.length} painted frames with no save warning or layout shift; final volume persisted.`);
  } finally {
    await window.evaluate(() => { cancelAnimationFrame(globalThis.window.volumeLayout!.raf); delete globalThis.window.volumeLayout; });
    await window.getByRole('button', { name: 'Close settings', exact: true }).click();
  }
}
async function checkTraceExport(window: Page) {
  const selection = (await window.evaluate(() => globalThis.window.review.snapshot())).library;
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.getByText('Timing diagnostics', { exact: true }).click();
  const option = window.getByLabel('Include local file paths in exported trace', { exact: true });
  assert.equal(await option.isChecked(), false);
  for (const includePaths of [false, true]) {
    await option.setChecked(includePaths);
    const path = join(folder, includePaths ? 'trace-with-paths.json' : 'trace-redacted.json');
    await app!.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: selected })) as typeof dialog.showSaveDialog; }, path);
    await window.getByRole('button', { name: 'Export timing trace', exact: true }).click();
    const deadline = Date.now() + 10000;
    let report: TraceReport | undefined;
    while (Date.now() < deadline) {
      try { report = JSON.parse(await readFile(path, 'utf8')); break; } catch { await delay(50); }
    }
    assert(report, 'Trace export did not finish');
    assert.equal(report.schemaVersion, 2); assert.equal(report.includePaths, includePaths);
    assert.equal(report.selection.mediaHash, selection!.recording!.hash);
    assert.equal('replayHash' in report.selection, false);
    assert.equal(report.selection.boundToRuntime, false);
    assert.equal(report.trace.clock, 'sync-worker-monotonic-seconds');
    assert.equal(report.trace.context.controllerConfig.freshnessSeconds, 0.3);
    assert.equal(report.trace.context.media.selectedTrackId, 1);
    assert(Math.abs(report.trace.context.offsetSeconds - 2.51) < 1e-8);
    assert(report.trace.entries.some(entry => entry.event === 'controller' && entry.data.status!.state === 'preview'));
    assert(report.trace.entries.some(entry => entry.event === 'audio' && Number.isFinite(entry.data.positionSeconds)));
    assert(report.trace.entries.some(entry => entry.event === 'controller-input' && entry.data.type === 'unbind'));
    const loaded = report.trace.entries.find(entry => entry.event === 'user-intent' && entry.data.type === 'load');
    assert.equal(loaded!.data.path, includePaths ? mediaPath : '<local path>');
    if (!includePaths) assert.equal(JSON.stringify(report).includes(folder), false);
    assert(report.trace.retention.retainedBytes <= report.trace.retention.maxBytes);
  }
  await window.getByRole('button', { name: 'Close settings', exact: true }).click();
  console.log('Real desktop trace export: state, alignment, audio clocks, bounded history, and explicit path inclusion passed.');
}
async function ownedPlayerPipe() {
  // Inspect only descendants of this test's Electron process. The production
  // application has no arbitrary-IPC testing command or process-discovery hook.
  const queue = [app!.process().pid], seen = new Set<number | undefined>(), pipes = [];
  while (queue.length && seen.size < 128) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
    const pipe = args.find(arg => arg.startsWith('--input-ipc-server='));
    if (pipe && basename(args[0] ?? '') === 'mpv') pipes.push(pipe.slice('--input-ipc-server='.length));
    for (const tid of await readdir(`/proc/${pid}/task`).catch(() => [])) {
      const children = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8').catch(() => '');
      queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
    }
  }
  assert.equal(pipes.length, 1, 'Expected one player owned by the test app');
  return pipes[0]!;
}
async function nativeCommand<Result = unknown>(pipe: string, command: (string | number)[], mayDisconnect = false) {
  return new Promise<Result>((resolveCommand, reject) => {
    const socket = createConnection(pipe);
    let buffer = '', settled = false;
    const finish = (error?: Error, data?: Result) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); socket.destroy();
      if (error) reject(error); else resolveCommand(data as Result);
    };
    const deadline = setTimeout(() => finish(new Error('Test player command timed out')), 3000);
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(mayDisconnect ? undefined : new Error('Test player disconnected')));
    socket.on('connect', () => socket.write(JSON.stringify({ command, request_id: 1 }) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const reply = JSON.parse(line);
        if (reply.request_id === 1) finish(reply.error === 'success' ? undefined : new Error(reply.error), reply.data);
      }
    });
  });
}
async function checkOutputRecovery(window: Page) {
  if (process.platform !== 'linux') return; // Native Windows hotplug has its own acceptance matrix.
  const before = await window.evaluate(() => globalThis.window.review.snapshot());
  const pipe = await ownedPlayerPipe();
  await window.evaluate(() => globalThis.window.review.command({ type: 'preview', paused: false }));
  // Interrupt the audible renderer, not the metadata-only mpv output.
  await app!.evaluate(async ({ BrowserWindow }) => {
    const audio = BrowserWindow.getAllWindows().find(item => !item.isVisible());
    if (!audio) throw new Error('Audio renderer is missing');
    await audio.webContents.executeJavaScript('globalThis.audioEngine.context.suspend()');
  });
  const after = await waitState(window, state => !state.busy && !state.error && state.paused && state.audioOutput?.driver === 'Web Audio' && state.audioOutput.revision > before.audioOutput!.revision, 30000);
  assert.equal(after.offsetSeconds, before.offsetSeconds);
  assert.deepEqual(after.library!.alignment, before.library!.alignment);
  assert.equal(after.media!.selectedTrackId, before.media!.selectedTrackId);
  const replacement = await ownedPlayerPipe();
  assert.notEqual(replacement, pipe);
  const volume = await app!.evaluate(async ({ BrowserWindow }) => {
    const audio = BrowserWindow.getAllWindows().find(item => !item.isVisible());
    if (!audio) throw new Error('Audio renderer is missing');
    return audio.webContents.executeJavaScript('globalThis.audioEngine.volume');
  });
  assert.equal(volume, before.library!.volume);
  const tracks = await nativeCommand<{ type: string; selected: boolean; id: number }[]>(replacement, ['get_property', 'track-list']);
  assert.equal(tracks.find(track => track.type === 'audio' && track.selected)!.id, before.media!.selectedTrackId);
  await window.evaluate(() => globalThis.window.review.command({ type: 'preview', paused: false }));
  await waitState(window, state => !state.paused);
  await window.evaluate(() => globalThis.window.review.command({ type: 'preview', paused: true }));
  await waitState(window, state => state.paused);
  console.log(`Real Electron output recovery: interrupted Web Audio, replaced player, paused preview, track ${before.media!.selectedTrackId}, actual volume, and retained offset passed.`);
}
async function checkPowerRecovery(window: Page) {
  const before = await window.evaluate(() => globalThis.window.review.snapshot());
  await app!.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); powerMonitor.emit('suspend'); });
  await waitState(window, state => state.busy && state.paused && !state.replay);
  const rejected = await window.evaluate(async () => { try { await globalThis.window.review.command({ type: 'preview', paused: false }); return ''; } catch (error) { return String(error); } });
  assert.match(rejected, /interrupted/);
  await app!.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); powerMonitor.emit('resume'); });
  const after = await waitState(window, state => !state.busy && !state.error && state.media?.name === before.media!.name && state.paused);
  assert.equal(after.media!.selectedTrackId, before.media!.selectedTrackId);
  assert.equal(after.library!.volume, before.library!.volume);
  assert.deepEqual(after.library!.alignment, before.library!.alignment);
  assert.equal(after.library!.recording!.hash, before.library!.recording!.hash);
  assert.equal(after.offsetSeconds, undefined, 'Runtime alignment must wait for fresh replay confirmation');
  await window.evaluate(() => globalThis.window.review.command({ type: 'retry' }));
  await waitState(window, state => !state.busy && !state.error && state.paused && state.media?.selectedTrackId === before.media!.selectedTrackId);
  await window.evaluate(() => globalThis.window.review.command({ type: 'preview', paused: false }));
  await waitState(window, state => !state.paused);
  await window.evaluate(() => globalThis.window.review.command({ type: 'preview', paused: true }));
  await waitState(window, state => state.paused);
  console.log(`Real Electron power routing: duplicate suspend/resume, blocked unpause, paused restoration, track ${before.media!.selectedTrackId}, retained alignment, and playback retry passed.`);
}
try {
  let window = await launch();
  const leagueFolder = join(folder, 'League café'), configFolder = join(leagueFolder, 'Config');
  await mkdir(configFolder, { recursive: true });
  await writeFile(join(leagueFolder, 'LeagueClient.exe'), 'MZ synthetic install marker; never executed');
  await writeFile(join(configFolder, 'game.cfg'), '[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
  await selectFile(leagueFolder);
  await window.getByRole('button', { name: 'Choose League folder', exact: true }).click();
  await waitState(window, state => state.setup?.selectedRoot === leagueFolder && state.setup.installations[0]!.configs[0]!.inspection.state === 'disabled');
  assert.equal(await readFile(join(configFolder, 'game.cfg'), 'utf8'), '[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
  if (process.platform === 'win32' || process.env.COMMS_TEST_POWERSHELL) {
    await window.getByRole('button', { name: 'Enable replay connection', exact: true }).click();
    await waitState(window, state => state.setup?.installations[0]?.configs[0]?.inspection.state === 'enabled' && !state.setup.editing, 30000);
    const enabled = await window.evaluate(() => globalThis.window.review.snapshot());
    const backup = enabled.setup!.installations[0]!.configs[0]!.backups![0];
    assert.equal(await readFile(backup!.path, 'utf8'), '[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
    assert.equal(await readFile(join(configFolder, 'game.cfg'), 'utf8'), '[General]\r\nEnableReplayApi=1\r\nOther=keep\r\n');
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await window.locator('.setup-panel > summary').click();
    await window.getByText('Configuration backups (1)', { exact: true }).click();
    await window.getByRole('button', { name: 'Restore previous config', exact: true }).click();
    await waitState(window, state => state.setup?.installations[0]?.configs[0]?.inspection.state === 'disabled' && !state.setup.editing, 30000);
    assert.equal(await readFile(join(configFolder, 'game.cfg'), 'utf8'), '[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
    await window.getByRole('button', { name: 'Close settings', exact: true }).click();
    await window.getByRole('button', { name: 'Enable replay connection', exact: true }).click();
    console.log('Real Electron config editing: scoped helper, minimal edit, original backup, restore, and re-enable passed.');
  } else {
    await writeFile(join(configFolder, 'game.cfg'), '[General]\r\nEnableReplayApi=1\r\nOther=keep\r\n');
    await window.evaluate(() => globalThis.window.review.command({ type: 'setup-refresh' }));
  }
  await waitState(window, state => state.setup?.installations[0]?.configs[0]?.inspection.state === 'enabled' && !state.replay);
  console.log('Real Electron setup: selected installation, read-only config detection, refresh, and independent disconnected state passed.');
  await window.getByRole('button', { name: 'Prepare a recording without League', exact: true }).click();
  await selectFile(mediaPath);
  await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
  const recordingHash = (await waitState(window, state => !!state.library?.recording?.hash, 30000)).library!.recording!.hash;
  await window.getByLabel('Recording offset (seconds)', { exact: true }).fill('2.5');
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.keyboard.press('Escape');
  assert.equal(await window.getByLabel('Recording offset (seconds)', { exact: true }).inputValue(), '2.5');
  await window.getByRole('button', { name: 'Forward 0.1 s', exact: true }).click({ modifiers: ['Alt'] });
  await waitState(window, state => Math.abs(state.offsetSeconds! - 2.51) < 1e-8);
  assert.equal(await window.getByRole('button', { name: 'Start listening', exact: true }).isDisabled(), true);
  await window.getByRole('button', { name: 'Done', exact: true }).click();
  await waitState(window, state => state.workflow?.state === 'ready.offline');
  await window.getByRole('button', { name: 'Adjust timing', exact: true }).click();
  await window.evaluate(() => globalThis.window.review.command({ type: 'volume', volume: 99 }));
  await checkVolumeLayout(window);
  await checkTraceExport(window);
  await checkOutputRecovery(window);
  await checkPowerRecovery(window);

  // Make only the library backup destination unwritable; keep Chromium's profile
  // and the last committed library intact. Exercise the actual window-close path.
  const backupPath = join(profile, 'library.json.backup'), heldBackup = join(folder, 'held-library-backup');
  await rename(backupPath, heldBackup); await mkdir(backupPath);
  const failure = await window.evaluate(async () => { try { await globalThis.window.review.command({ type: 'align', offsetSeconds: 4 }); return ''; } catch (error) { return String(error); } });
  assert.ok(failure); await waitState(window, state => state.library?.unsavedAlignments === 1 && state.offsetSeconds === 4);
  await window.evaluate(() => globalThis.window.review.command({ type: 'volume', volume: 37 }));
  await waitState(window, state => state.library?.unsavedPreferences === 1 && state.library.volume === 37 && state.library.saveError?.includes('Volume'));
  await app!.evaluate(({ BrowserWindow, dialog }) => {
    globalThis.exitDialogOptions = undefined;
    dialog.showMessageBox = (async (...args: [Electron.MessageBoxOptions] | [Electron.BaseWindow, Electron.MessageBoxOptions]) => {
      globalThis.exitDialogOptions = args.at(-1) as Electron.MessageBoxOptions;
      return new Promise<Electron.MessageBoxReturnValue>(resolve => { globalThis.answerExitDialog = resolve; });
    }) as typeof dialog.showMessageBox;
    const main = BrowserWindow.getAllWindows().find(item => item.isVisible());
    if (!main) throw new Error('Review window is missing');
    main.close();
  });
  const dialogDeadline = Date.now() + 10000;
  let exitOptions;
  while (Date.now() < dialogDeadline) {
    exitOptions = await app!.evaluate(() => globalThis.exitDialogOptions);
    if (exitOptions) break;
    await delay(50);
  }
  assert.equal(exitOptions?.title, 'Unsaved review changes');
  assert(exitOptions, 'Exit prompt did not appear');
  assert.match(exitOptions.detail ?? '', /unsaved preference/);
  const closingCommand = await window.evaluate(async () => { try { await globalThis.window.review.command({ type: 'align', offsetSeconds: 999 }); return ''; } catch (error) { return String(error); } });
  assert.match(closingCommand, /closing/);
  await app!.evaluate(() => globalThis.answerExitDialog({ response: 1, checkboxChecked: false }));
  await waitState(window, state => !state.busy && state.library?.unsavedAlignments === 1 && state.paused);
  await rm(backupPath, { recursive: true }); await rename(heldBackup, backupPath);
  await window.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await waitState(window, state => !state.library?.saveError && state.offsetSeconds === 4);
  assert.equal(Object.values((JSON.parse(await readFile(join(profile, 'library.json'), 'utf8')) as LibraryData).timings)[0]!.alignment.baseOffsetSeconds, 4);
  await window.evaluate(async () => { await globalThis.window.review.command({ type: 'align', offsetSeconds: 2.51 }); });
  console.log('Real Electron exit: failed alignment/volume saves, close prompt, rejected new edit, cancel, and successful retry preserved both changes.');
  await close();
  let saved: LibraryData = JSON.parse(await readFile(join(profile, 'library.json'), 'utf8'));
  assert.equal(Object.values(saved.timings)[0]!.alignment.baseOffsetSeconds, 2.51);
  assert.equal(Object.values(saved.timings)[0]!.alignment.correctionSeconds, 0);
  assert.equal(saved.settings.volume, 37);
  const renamed = join(folder, 'renamed café comms.wav');
  await rename(mediaPath, renamed); mediaPath = renamed;
  window = await launch();
  await window.getByRole('button', { name: 'Prepare a recording without League', exact: true }).click();
  await window.locator('.recent').filter({ hasText: 'comms.wav' }).first().click();
  await waitState(window, state => state.media?.name === basename(mediaPath) && state.offsetSeconds !== undefined);
  let restored = await window.evaluate(() => globalThis.window.review.snapshot());
  assert.ok(Math.abs(restored.offsetSeconds! - 2.51) < 1e-8);
  assert.equal(restored.library!.alignment!.correctionSeconds, 0);
  assert.equal(restored.library!.volume, 37);
  await close();
  const movedFolder = join(folder, 'new media folder'); await mkdir(movedFolder);
  const moved = join(movedFolder, basename(mediaPath)); await rename(mediaPath, moved);
  window = await launch();
  await window.getByRole('button', { name: 'Prepare a recording without League', exact: true }).click();
  await window.evaluate(id => globalThis.window.review.command({ type: 'select-recording', id }), `media:${recordingHash}`);
  await window.getByRole('button', { name: 'Locate recording', exact: true }).waitFor();
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await selectFile(movedFolder);
  await window.getByRole('button', { name: 'Add media folder', exact: true }).click();
  await waitState(window, state => !!state.library?.alignment);
  restored = await window.evaluate(() => globalThis.window.review.snapshot());
  assert.ok(Math.abs(restored.offsetSeconds! - 2.51) < 1e-8);
  assert.equal(restored.library!.recording!.path, moved);
  assert.equal(restored.library!.missingRecording, false);
  await window.getByRole('button', { name: 'Close settings', exact: true }).click();
  const ffmpeg = process.env.COMMS_TEST_FFMPEG ?? (process.platform === 'win32' ? resolve('resources/bin/win32-x64/ffmpeg.exe') : undefined);
  if (ffmpeg) {
    const encoded = join(folder, 'encoded.mkv'), video = join(folder, 'POV and comms.mkv');
    const run = promisify(execFile);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2', '-map', '0:v', '-map', '1:a', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-output_ts_offset', '5', encoded]);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-copyts', '-i', encoded, '-map', '0', '-c', 'copy', '-metadata:s:a', 'encoder=Recorder', video]);
    await window.getByRole('button', { name: 'Change recording', exact: true }).click();
    await selectFile(video);
    await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
    const inspected = await waitState(window, state => state.media?.name === basename(video) && state.media.tracks[0]?.range?.evidence === 'packet-scan' && !!state.library?.recording?.hash && state.library.timingAnalysis !== 'running');
    assert.ok(inspected.media!.probe!.streams.some(stream => stream.type === 'video'));
    await window.getByRole('button', { name: 'Use this track', exact: true }).click();
    await waitState(window, state => state.workflow?.state === 'alignment.manual' && state.library?.clock?.status === 'needs-attention', 180000);
    assert.equal(await window.getByRole('heading', { name: 'Adjust timing', exact: true }).count(), 1);
    assert.equal(await window.getByText('Automatic timing could not be detected.', { exact: false }).count(), 1);
    assert.equal(await window.locator('.video-preview, .frame-stage, .crop-surface, .crop-inputs').count(), 0);
    await window.getByLabel('Recording offset (seconds)', { exact: true }).fill('-0.5');
    await window.getByRole('button', { name: 'Back 0.1 s', exact: true }).click();
    await waitState(window, state => Math.abs(state.offsetSeconds! + .6) < 1e-8);
    const library: LibraryData = JSON.parse(await readFile(join(profile, 'library.json'), 'utf8'));
    const cached = library.media[inspected.library!.recording!.hash!];
    assert.ok(cached!.probe!.data.streams.find(stream => stream.type === 'audio')!.packetRange);
    assert.equal(await window.locator('.task input').count(), 1);
    await mkdir('.cache', { recursive: true });
    await window.screenshot({ path: '.cache/timing-editor.png', fullPage: true });
    await window.getByRole('button', { name: 'Detect offset from video clock', exact: true }).click();
    await waitState(window, state => state.library?.clock?.status === 'running');
    const failedRetry = await waitState(window, state => state.workflow?.state === 'alignment.manual' && state.library?.clock?.status === 'needs-attention', 180000);
    assert.ok(Math.abs(failedRetry.offsetSeconds! + .6) < 1e-8, 'Failed clock detection must retain the accepted manual offset');
    assert.equal(await window.getByLabel('Recording offset (seconds)', { exact: true }).inputValue(), '-0.6');
    console.log('Real Electron fallback: failed detection opens one live offset, with no waveform, frame selection, or timestamp pairs.');
    const secondTrack = inspected.media!.tracks[1]!.id;
    await window.evaluate(async id => { await globalThis.window.review.command({ type: 'track', trackId: id }); await globalThis.window.review.command({ type: 'align', offsetSeconds: 2.5 }); }, secondTrack);
    await checkOutputRecovery(window);
    await checkPowerRecovery(window);
    const originalVideo = await readFile(video), beforeReplacement = await window.evaluate(() => globalThis.window.review.snapshot());
    await app!.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
    await waitState(window, state => state.busy && state.paused);
    // The player is terminated, but allow Windows a short interval to release
    // the fixture handle before deliberately replacing the recording.
    for (let attempt = 0; ; attempt++) {
      try { await writeFile(video, 'Changed recording while the system was suspended'); break; }
      catch (error) { if (attempt >= 20 || !(error instanceof Error && 'code' in error && ['EACCES', 'EPERM', 'EBUSY'].includes(String(error.code)))) throw error; await delay(50); }
    }
    await app!.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    const refused = await waitState(window, state => !state.busy && state.error?.includes('Recording changed'));
    assert.equal(refused.paused, true);
    assert.equal(refused.offsetSeconds, undefined);
    assert.deepEqual(refused.library!.alignment, beforeReplacement.library!.alignment);
    await writeFile(video, originalVideo);
    await window.getByRole('button', { name: 'Change recording', exact: true }).click();
    await selectFile(video);
    await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
    await waitState(window, state => !state.error && !state.busy && state.media?.selectedTrackId === secondTrack && state.offsetSeconds === 2.5 && !!state.library!.recording!.hash);
    console.log('Real Electron power recovery refuses replaced recording bytes, retains the alignment, and permits explicit reopening after failure.');
    if (existsSync('resources/ocr/verified.json')) {
      const clockVideo = join(folder, 'clock with comms.mkv');
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', resolve('tests/fixtures/ocr/clock-video.mkv'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-map', '0:v', '-map', '1:a', '-t', '4', '-vf', 'scale=68:26:flags=lanczos,pad=1920:1080:1852:0:color=0x111827', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '1', '-c:a', 'pcm_s16le', clockVideo]);
      await window.getByRole('button', { name: 'Change recording', exact: true }).click();
      await selectFile(clockVideo);
      await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
      await waitState(window, state => state.media?.name === basename(clockVideo) && state.library?.clock?.status === 'running');
      await window.getByRole('button', { name: 'Align manually', exact: true }).click();
      await window.getByLabel('Recording offset (seconds)', { exact: true }).fill('3');
      await window.getByRole('button', { name: 'Done', exact: true }).click();
      await waitState(window, state => state.offsetSeconds === 3 && !state.library?.clock);
      await window.getByRole('button', { name: 'Adjust timing', exact: true }).click();
      await window.getByLabel('Recording offset (seconds)', { exact: true }).fill('-');
      await window.getByRole('button', { name: 'Detect offset from video clock', exact: true }).click();
      const estimate = await waitState(window, state => state.library?.clock?.status === 'accepted' || state.library?.clock?.status === 'needs-attention', 180000);
      assert.equal(estimate.library!.clock!.status, 'accepted', estimate.library!.clock!.message);
      assert.ok(Math.abs(estimate.offsetSeconds! + 100) < 0.06);
      assert.equal(estimate.library!.alignment!.source, 'video-clock');
      const evidence = estimate.library!.alignment!.clock!.evidence;
    assert.equal(evidence.algorithmVersion, 2);
    assert('method' in evidence);
    assert.equal(evidence.method, 'transition-midpoint');
      assert.equal(estimate.workflow!.state, 'ready.offline');
      assert.equal(estimate.library!.boundToRuntime, false, 'Automatic alignment must not start listening');
      await close();
      const renamedClock = join(folder, 'renamed clock café.mkv'); await rename(clockVideo, renamedClock);
      window = await launch();
      await window.getByRole('button', { name: 'Prepare a recording without League', exact: true }).click();
      await selectFile(renamedClock);
      await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
      await waitState(window, state => state.library?.alignment?.source === 'video-clock' && state.workflow?.state === 'ready.offline', 30000);
      await window.getByRole('button', { name: 'Adjust timing', exact: true }).click();
      await window.getByRole('button', { name: 'Settings', exact: true }).click();
      await window.getByRole('button', { name: 'Read game clock again', exact: true }).click();
      const reused = await waitState(window, state => state.library?.clock?.status === 'accepted', 180000);

      assert.ok(Math.abs(reused.library!.clock!.offsetSeconds! + 100) < 0.06);
      assert.ok(Math.abs(reused.offsetSeconds! + 100) < 0.06, 'Reanalysis must preserve the same midpoint offset');
      assert.equal(await window.locator('.video-preview, .frame-stage, .crop-surface, .crop-inputs').count(), 0);
      console.log('Real Electron clock reading: top-right detection, offline OCR, cancellation by manual edit, automatic midpoint application, and explicit Start requirement passed.');
      console.log('Real Electron recording recovery: automatic timing restored after restart and Unicode rename; reanalysis applies the midpoint.');
    }
  }
  assert.deepEqual(errors, []);
  await mkdir('.cache', { recursive: true });
  await window.screenshot({ path: '.cache/review-window.png', fullPage: true });
  console.log('Real Electron review: import, live offset edits, persistence, rename, and configured-folder relocation passed.');
} catch (error) {
  if (app) {
    const window = await app.firstWindow();
    console.error('Failed review state:', await window.evaluate(() => globalThis.window.review.snapshot()));
    console.error('Visible text:', await window.locator('body').innerText());
    await mkdir('.cache', { recursive: true });
    await window.screenshot({ path: '.cache/review-failure.png', fullPage: true });
  }
  throw error;
} finally {
  if (app) {
    // A failed exit assertion can leave its dialog stub pending. Teardown owns
    // this temporary profile and must not wait for another user decision.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 2, checkboxChecked: false })) as typeof dialog.showMessageBox; }).catch(() => undefined);
    await close();
  }
  await rm(folder, { recursive: true, force: true });
}
