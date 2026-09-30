import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Uses the real Electron main/preload/renderer, disk library, hash worker, and mpv.
// A null output and generated recording make this a workflow test, not an audible timing gate.
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
let app;
const errors = [];
async function waitState(window, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let state;
  do {
    state = await window.evaluate(() => window.review.snapshot());
    if (predicate(state)) return state;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Review state did not converge: ${JSON.stringify(state)}`);
}
async function waitPreview(window, predicate) {
  const deadline = Date.now() + 10000;
  let preview;
  do {
    preview = await window.evaluate(() => window.review.preview());
    if (predicate(preview)) return preview;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Preview did not converge: ${JSON.stringify({ ...preview, waveform: preview.waveform && { ...preview.waveform, peaks: preview.waveform.peaks.length }, frame: preview.frame && { ...preview.frame, dataUrl: '<image>' } })}`);
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
async function selectFile(path) {
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path);
}
async function close() { await app.close(); app = undefined; }
async function checkTraceExport(window) {
  const selection = (await window.evaluate(() => window.review.snapshot())).library;
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.getByText('Timing diagnostics', { exact: true }).click();
  const option = window.getByLabel('Include local file paths in exported trace', { exact: true });
  assert.equal(await option.isChecked(), false);
  for (const includePaths of [false, true]) {
    await option.setChecked(includePaths);
    const path = join(folder, includePaths ? 'trace-with-paths.json' : 'trace-redacted.json');
    await app.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, path);
    await window.getByRole('button', { name: 'Export timing trace', exact: true }).click();
    const deadline = Date.now() + 10000;
    let report;
    while (Date.now() < deadline) {
      try { report = JSON.parse(await readFile(path, 'utf8')); break; } catch { await delay(50); }
    }
    assert(report, 'Trace export did not finish');
    assert.equal(report.schemaVersion, 2); assert.equal(report.includePaths, includePaths);
    assert.equal(report.selection.mediaHash, selection.recording.hash);
    assert.equal('replayHash' in report.selection, false);
    assert.equal(report.selection.boundToRuntime, false);
    assert.equal(report.trace.clock, 'sync-worker-monotonic-seconds');
    assert.equal(report.trace.context.controllerConfig.freshnessSeconds, 0.3);
    assert.equal(report.trace.context.media.selectedTrackId, 1);
    assert(Math.abs(report.trace.context.offsetSeconds - 2.51) < 1e-8);
    assert(report.trace.entries.some(entry => entry.event === 'controller' && entry.data.status.state === 'preview'));
    assert(report.trace.entries.some(entry => entry.event === 'audio' && Number.isFinite(entry.data.positionSeconds)));
    assert(report.trace.entries.some(entry => entry.event === 'controller-input' && entry.data.type === 'unbind'));
    const loaded = report.trace.entries.find(entry => entry.event === 'user-intent' && entry.data.type === 'load');
    assert.equal(loaded.data.path, includePaths ? mediaPath : '<local path>');
    if (!includePaths) assert.equal(JSON.stringify(report).includes(folder), false);
    assert(report.trace.retention.retainedBytes <= report.trace.retention.maxBytes);
  }
  await window.getByRole('button', { name: 'Close settings', exact: true }).click();
  console.log('Real desktop trace export: state, alignment, audio clocks, bounded history, and explicit path inclusion passed.');
}
async function ownedPlayerPipe() {
  // Inspect only descendants of this test's Electron process. The production
  // application has no arbitrary-IPC testing command or process-discovery hook.
  const queue = [app.process().pid], seen = new Set(), pipes = [];
  while (queue.length && seen.size < 128) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
    const pipe = args.find(arg => arg.startsWith('--input-ipc-server='));
    if (pipe && basename(args[0]) === 'mpv') pipes.push(pipe.slice('--input-ipc-server='.length));
    for (const tid of await readdir(`/proc/${pid}/task`).catch(() => [])) {
      const children = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8').catch(() => '');
      queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
    }
  }
  assert.equal(pipes.length, 1, 'Expected one player owned by the test app');
  return pipes[0];
}
async function nativeCommand(pipe, command, mayDisconnect = false) {
  return new Promise((resolveCommand, reject) => {
    const socket = createConnection(pipe);
    let buffer = '', settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); socket.destroy();
      if (error) reject(error); else resolveCommand(data);
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
async function checkOutputRecovery(window) {
  if (process.platform !== 'linux') return; // Native Windows hotplug has its own acceptance matrix.
  const before = await window.evaluate(() => window.review.snapshot());
  const pipe = await ownedPlayerPipe();
  await window.evaluate(() => window.review.command({ type: 'preview', paused: false }));
  await nativeCommand(pipe, ['ao-reload'], true);
  const after = await waitState(window, state => !state.busy && !state.error && state.paused && state.audioOutput?.driver === 'null' && state.audioOutput.revision > before.audioOutput.revision, 30000);
  assert.equal(after.offsetSeconds, before.offsetSeconds);
  assert.deepEqual(after.library.alignment, before.library.alignment);
  assert.equal(after.media.selectedTrackId, before.media.selectedTrackId);
  const replacement = await ownedPlayerPipe();
  assert.notEqual(replacement, pipe);
  assert.equal(await nativeCommand(replacement, ['get_property', 'volume']), before.library.volume);
  const tracks = await nativeCommand(replacement, ['get_property', 'track-list']);
  assert.equal(tracks.find(track => track.type === 'audio' && track.selected).id, before.media.selectedTrackId);
  await window.evaluate(() => window.review.command({ type: 'preview', paused: false }));
  await waitState(window, state => !state.paused);
  await window.evaluate(() => window.review.command({ type: 'preview', paused: true }));
  await waitState(window, state => state.paused);
  console.log(`Real Electron output recovery: native reconfiguration, replaced player, paused preview, track ${before.media.selectedTrackId}, actual volume, and retained offset passed.`);
}
async function checkPowerRecovery(window) {
  const before = await window.evaluate(() => window.review.snapshot());
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); powerMonitor.emit('suspend'); });
  await waitState(window, state => state.busy && state.paused && !state.replay);
  const rejected = await window.evaluate(async () => { try { await window.review.command({ type: 'preview', paused: false }); return ''; } catch (error) { return String(error); } });
  assert.match(rejected, /interrupted/);
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); powerMonitor.emit('resume'); });
  const after = await waitState(window, state => !state.busy && !state.error && state.media?.name === before.media.name && state.paused);
  assert.equal(after.media.selectedTrackId, before.media.selectedTrackId);
  assert.equal(after.library.volume, before.library.volume);
  assert.deepEqual(after.library.alignment, before.library.alignment);
  assert.equal(after.library.recording.hash, before.library.recording.hash);
  assert.equal(after.offsetSeconds, undefined, 'Runtime alignment must wait for fresh replay confirmation');
  await window.evaluate(() => window.review.command({ type: 'retry' }));
  await waitState(window, state => !state.busy && !state.error && state.paused && state.media?.selectedTrackId === before.media.selectedTrackId);
  await window.evaluate(() => window.review.command({ type: 'preview', paused: false }));
  await waitState(window, state => !state.paused);
  await window.evaluate(() => window.review.command({ type: 'preview', paused: true }));
  await waitState(window, state => state.paused);
  console.log(`Real Electron power routing: duplicate suspend/resume, blocked unpause, paused restoration, track ${before.media.selectedTrackId}, retained alignment, and playback retry passed.`);
}
try {
  let window = await launch();
  const leagueFolder = join(folder, 'League café'), configFolder = join(leagueFolder, 'Config');
  await mkdir(configFolder, { recursive: true });
  await writeFile(join(leagueFolder, 'LeagueClient.exe'), 'MZ synthetic install marker; never executed');
  await writeFile(join(configFolder, 'game.cfg'), '[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
  await selectFile(leagueFolder);
  await window.getByRole('button', { name: 'Choose League folder', exact: true }).click();
  await waitState(window, state => state.setup?.selectedRoot === leagueFolder && state.setup.installations[0].configs[0].inspection.state === 'disabled');
  assert.equal(await readFile(join(configFolder, 'game.cfg'), 'utf8'), '[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
  if (process.platform === 'win32' || process.env.COMMS_TEST_POWERSHELL) {
    await window.getByRole('button', { name: 'Enable replay connection', exact: true }).click();
    await waitState(window, state => state.setup?.installations[0]?.configs[0]?.inspection.state === 'enabled' && !state.setup.editing, 30000);
    const enabled = await window.evaluate(() => window.review.snapshot());
    const backup = enabled.setup.installations[0].configs[0].backups[0];
    assert.equal(await readFile(backup.path, 'utf8'), '[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
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
    await window.evaluate(() => window.review.command({ type: 'setup-refresh' }));
  }
  await waitState(window, state => state.setup?.installations[0]?.configs[0]?.inspection.state === 'enabled' && !state.replay);
  console.log('Real Electron setup: selected installation, read-only config detection, refresh, and independent disconnected state passed.');
  await window.getByRole('button', { name: 'Prepare a recording without League', exact: true }).click();
  await selectFile(mediaPath);
  await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
  const recordingHash = (await waitState(window, state => !!state.library?.recording?.hash, 30000)).library.recording.hash;
  const waveform = await waitPreview(window, preview => preview.waveform?.complete);
  assert.ok(waveform.waveform.peaks.length > 100);
  assert.ok(waveform.waveform.peaks.some(peak => peak[3] > 0));
  await window.getByRole('slider', { name: 'Audio waveform', exact: true }).click({ position: { x: 400, y: 50 } });
  await waitState(window, state => state.positionSeconds > 1 && state.paused);
  await window.getByLabel('Game time at this moment', { exact: true }).fill('0:02');
  await window.getByLabel('Recording time', { exact: true }).fill('0:04.5');
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.keyboard.press('Escape');
  assert.equal(await window.getByLabel('Recording time', { exact: true }).inputValue(), '0:04.5');
  assert.equal(await window.getByLabel('Game time at this moment', { exact: true }).inputValue(), '0:02');
  await window.getByLabel('Fine adjustment (10 ms)', { exact: true }).check();
  await window.getByRole('button', { name: 'Comms earlier', exact: true }).click();
  await window.getByRole('button', { name: 'Use this moment', exact: true }).click();
  await waitState(window, state => Math.abs(state.offsetSeconds - 2.51) < 1e-8);
  await window.getByRole('button', { name: 'Adjust timing', exact: true }).click();
  await window.getByRole('button', { name: 'Preview recording', exact: true }).click();
  await waitState(window, state => !state.paused && state.positionSeconds > 0.1);
  await window.getByRole('button', { name: 'Pause recording', exact: true }).click();
  await waitState(window, state => state.paused);
  await window.evaluate(() => window.review.command({ type: 'volume', volume: 99 }));
  assert.equal(await window.getByRole('button', { name: 'Start listening', exact: true }).count(), 0);
  await checkTraceExport(window);
  await checkOutputRecovery(window);
  await checkPowerRecovery(window);

  // Make only the library backup destination unwritable; keep Chromium's profile
  // and the last committed library intact. Exercise the actual window-close path.
  const backupPath = join(profile, 'library.json.backup'), heldBackup = join(folder, 'held-library-backup');
  await rename(backupPath, heldBackup); await mkdir(backupPath);
  const failure = await window.evaluate(async () => { try { await window.review.command({ type: 'align', offsetSeconds: 4 }); return ''; } catch (error) { return String(error); } });
  assert.ok(failure); await waitState(window, state => state.library?.unsavedAlignments === 1 && state.offsetSeconds === 4);
  const volumeFailure = await window.evaluate(async () => { try { await window.review.command({ type: 'volume', volume: 37 }); return ''; } catch (error) { return String(error); } });
  assert.ok(volumeFailure);
  await waitState(window, state => state.library?.unsavedPreferences === 1 && state.library.volume === 37);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    globalThis.exitDialogOptions = undefined;
    dialog.showMessageBox = async (...args) => {
      globalThis.exitDialogOptions = args.at(-1);
      return new Promise(resolve => { globalThis.answerExitDialog = resolve; });
    };
    BrowserWindow.getAllWindows()[0].close();
  });
  const dialogDeadline = Date.now() + 10000;
  let exitOptions;
  while (Date.now() < dialogDeadline) {
    exitOptions = await app.evaluate(() => globalThis.exitDialogOptions);
    if (exitOptions) break;
    await delay(50);
  }
  assert.equal(exitOptions?.title, 'Unsaved review changes');
  assert.match(exitOptions.detail, /unsaved preference/);
  const closingCommand = await window.evaluate(async () => { try { await window.review.command({ type: 'align', offsetSeconds: 999 }); return ''; } catch (error) { return String(error); } });
  assert.match(closingCommand, /closing/);
  await app.evaluate(() => globalThis.answerExitDialog({ response: 1, checkboxChecked: false }));
  await waitState(window, state => !state.busy && state.library?.unsavedAlignments === 1 && state.paused);
  await rm(backupPath, { recursive: true }); await rename(heldBackup, backupPath);
  await window.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await waitState(window, state => !state.library?.saveError && state.offsetSeconds === 4);
  assert.equal(Object.values(JSON.parse(await readFile(join(profile, 'library.json'), 'utf8')).timings)[0].alignment.baseOffsetSeconds, 4);
  await window.evaluate(async () => { await window.review.command({ type: 'align', offsetSeconds: 2.5 }); await window.review.command({ type: 'nudge', deltaSeconds: 0.01 }); });
  console.log('Real Electron exit: failed alignment/volume saves, close prompt, rejected new edit, cancel, and successful retry preserved both changes.');
  await close();
  let saved = JSON.parse(await readFile(join(profile, 'library.json'), 'utf8'));
  assert.equal(Object.values(saved.timings)[0].alignment.baseOffsetSeconds, 2.5);
  assert.equal(Object.values(saved.timings)[0].alignment.correctionSeconds, 0.01);
  assert.equal(saved.settings.volume, 37);
  const renamed = join(folder, 'renamed café comms.wav');
  await rename(mediaPath, renamed); mediaPath = renamed;
  window = await launch();
  await window.getByRole('button', { name: 'Prepare a recording without League', exact: true }).click();
  await window.locator('.recent').filter({ hasText: 'comms.wav' }).first().click();
  await waitState(window, state => state.media?.name === basename(mediaPath) && state.offsetSeconds !== undefined);
  let restored = await window.evaluate(() => window.review.snapshot());
  assert.ok(Math.abs(restored.offsetSeconds - 2.51) < 1e-8);
  assert.equal(restored.library.alignment.correctionSeconds, 0.01);
  assert.equal(restored.library.volume, 37);
  await close();
  const movedFolder = join(folder, 'new media folder'); await mkdir(movedFolder);
  const moved = join(movedFolder, basename(mediaPath)); await rename(mediaPath, moved);
  window = await launch();
  await window.getByRole('button', { name: 'Prepare a recording without League', exact: true }).click();
  await window.evaluate(id => window.review.command({ type: 'select-recording', id }), `media:${recordingHash}`);
  await window.getByRole('button', { name: 'Locate recording', exact: true }).waitFor();
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await selectFile(movedFolder);
  await window.getByRole('button', { name: 'Add media folder', exact: true }).click();
  await waitState(window, state => !!state.library?.alignment);
  restored = await window.evaluate(() => window.review.snapshot());
  assert.ok(Math.abs(restored.offsetSeconds - 2.51) < 1e-8);
  assert.equal(restored.library.recording.path, moved);
  assert.equal(restored.library.missingRecording, false);
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
    assert.ok(inspected.media.probe.streams.some(stream => stream.type === 'video'));
    await window.getByRole('button', { name: 'Use this track', exact: true }).click();
    await window.getByRole('button', { name: 'Align manually', exact: true }).click();
    const target = inspected.media.tracks[0].range.startSeconds + 0.5;
    await window.getByLabel('Go to recording time', { exact: true }).fill(String(target));
    await window.getByRole('button', { name: 'Go', exact: true }).click();
    await waitState(window, state => Math.abs(state.positionSeconds - target) < 0.025);
    const cached = JSON.parse(await readFile(join(profile, 'library.json'), 'utf8')).media[inspected.library.recording.hash];
    assert.ok(cached.probe.data.streams.find(stream => stream.type === 'audio').packetRange);
    const still = await waitPreview(window, preview => !!preview.frame && !preview.frameBusy && preview.waveform?.complete);
    assert.ok(still.frame.positionSeconds >= target && still.frame.positionSeconds - target < 0.1);
    await window.getByRole('button', { name: 'Use frame as recording timestamp', exact: true }).click();
    assert.match(await window.getByLabel('Recording time', { exact: true }).inputValue(), /^0:/);
    console.log('Real Electron video import: background packet bounds, canonical seek, and cached timing passed.');
    console.log('Real Electron previews: timestamped waveform, video still, and manual timestamp selection passed.');
    const secondTrack = inspected.media.tracks[1].id;
    await window.evaluate(async id => { await window.review.command({ type: 'track', trackId: id }); await window.review.command({ type: 'align', offsetSeconds: 2.5 }); }, secondTrack);
    await checkOutputRecovery(window);
    await checkPowerRecovery(window);
    const originalVideo = await readFile(video), beforeReplacement = await window.evaluate(() => window.review.snapshot());
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
    await waitState(window, state => state.busy && state.paused);
    // The player is terminated, but allow Windows a short interval to release
    // the fixture handle before deliberately replacing the recording.
    for (let attempt = 0; ; attempt++) {
      try { await writeFile(video, 'Changed recording while the system was suspended'); break; }
      catch (error) { if (attempt >= 20 || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error; await delay(50); }
    }
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    const refused = await waitState(window, state => !state.busy && state.error?.includes('Recording changed'));
    assert.equal(refused.paused, true);
    assert.equal(refused.offsetSeconds, undefined);
    assert.deepEqual(refused.library.alignment, beforeReplacement.library.alignment);
    await writeFile(video, originalVideo);
    await window.getByRole('button', { name: 'Change recording', exact: true }).click();
    await selectFile(video);
    await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
    await waitState(window, state => !state.error && !state.busy && state.media?.selectedTrackId === secondTrack && state.offsetSeconds === 2.5 && !!state.library.recording.hash);
    console.log('Real Electron power recovery refuses replaced recording bytes, retains the alignment, and permits explicit reopening after failure.');
    if (existsSync('resources/ocr/verified.json')) {
      const clockVideo = join(folder, 'clock with comms.mkv');
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', resolve('tests/fixtures/ocr/clock-video.mkv'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-map', '0:v', '-map', '1:a', '-t', '130', '-c:v', 'copy', '-c:a', 'pcm_s16le', clockVideo]);
      await window.getByRole('button', { name: 'Change recording', exact: true }).click();
      await selectFile(clockVideo);
      await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
      await waitState(window, state => state.media?.name === basename(clockVideo) && !!state.library?.recording?.hash && state.library.clock?.status === 'needs-attention', 180000);
      await waitPreview(window, preview => !!preview.frame && !preview.frameBusy);
      const selector = window.getByLabel('Clock region selector', { exact: true });
      await selector.scrollIntoViewIfNeeded();
      const clockBox = await selector.boundingBox();
      await window.mouse.move(clockBox.x + clockBox.width * 0.01, clockBox.y + clockBox.height * 0.01);
      await window.mouse.down();
      await window.mouse.move(clockBox.x + clockBox.width * 0.99, clockBox.y + clockBox.height * 0.99, { steps: 4 });
      await window.mouse.up();
      await waitPreview(window, preview => preview.crop?.width > 0.95);
      await window.getByRole('button', { name: 'Read this clock', exact: true }).click();
      await waitState(window, state => state.library?.clock?.status === 'running');
      await window.getByRole('button', { name: 'Align manually', exact: true }).click();
      await window.getByLabel('Game time at this moment', { exact: true }).fill('0:02');
      await window.getByLabel('Recording time', { exact: true }).fill('0:05');
      await window.getByRole('button', { name: 'Use this moment', exact: true }).click();
      await waitState(window, state => state.offsetSeconds === 3 && !state.library?.clock);
      await window.getByRole('button', { name: 'Adjust timing', exact: true }).click();
      await window.getByText('More timing options', { exact: true }).click();
      await window.getByRole('button', { name: 'Read game clock again', exact: true }).click();
      const estimate = await waitState(window, state => state.library?.clock?.status === 'accepted' || state.library?.clock?.status === 'needs-attention', 180000);
      assert.equal(estimate.library.clock.status, 'accepted', estimate.library.clock.message);
      assert.ok(Math.abs(estimate.offsetSeconds + 100) < 0.06);
      assert.equal(estimate.library.alignment.source, 'video-clock');
      assert.equal(estimate.library.alignment.clock.evidence.method, 'transition-midpoint');
      assert.equal(estimate.workflow.state, 'ready.offline');
      assert.equal(estimate.library.boundToRuntime, false, 'Automatic alignment must not start listening');
      await close();
      const renamedClock = join(folder, 'renamed clock café.mkv'); await rename(clockVideo, renamedClock);
      window = await launch();
      await window.getByRole('button', { name: 'Prepare a recording without League', exact: true }).click();
      await selectFile(renamedClock);
      await window.getByRole('button', { name: 'Choose recording', exact: true }).click();
      await waitState(window, state => state.library?.alignment?.source === 'video-clock' && state.workflow?.state === 'ready.offline', 30000);
      await window.getByRole('button', { name: 'Adjust timing', exact: true }).click();
      await window.getByText('More timing options', { exact: true }).click();
      await window.getByRole('button', { name: 'Read game clock again', exact: true }).click();
      const reused = await waitState(window, state => state.library?.clock?.status === 'accepted', 180000);

      assert.ok(Math.abs(reused.library.clock.offsetSeconds + 100) < 0.06);
      assert.ok(Math.abs(reused.offsetSeconds + 100) < 0.06, 'Reanalysis must preserve the same midpoint offset');
      const rememberedCrop = await waitPreview(window, preview => preview.crop?.width > 0.95);
      assert.ok(rememberedCrop.crop.height > 0.95);
      console.log('Real Electron clock reading: offline OCR, crop retry, cancellation by manual edit, automatic midpoint application, and explicit Start requirement passed.');
      console.log('Real Electron recording recovery: saved crop and automatic timing restored after restart and Unicode rename; reanalysis applies the midpoint.');
    }
  }
  assert.deepEqual(errors, []);
  await mkdir('.cache', { recursive: true });
  await window.screenshot({ path: '.cache/review-window.png', fullPage: true });
  console.log('Real Electron review: import, timestamps, nudge, preview, persistence, rename, and configured-folder relocation passed.');
} catch (error) {
  if (app) {
    const window = await app.firstWindow();
    console.error('Failed review state:', await window.evaluate(() => window.review.snapshot()));
    console.error('Visible text:', await window.locator('body').innerText());
    await mkdir('.cache', { recursive: true });
    await window.screenshot({ path: '.cache/review-failure.png', fullPage: true });
  }
  throw error;
} finally {
  if (app) await close();
  await rm(folder, { recursive: true, force: true });
}
