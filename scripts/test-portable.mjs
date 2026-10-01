import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { digestFile, verifiedArtifact } from './artifact-evidence.mjs';
import { launchDesktop } from './portable-driver.mjs';

assert.equal(process.platform, 'win32', 'Portable execution validation requires Windows');
assert.equal(process.arch, 'x64', 'Portable execution validation requires an x64 Node process');
assert.equal(process.argv.length, 4, 'Usage: node scripts/test-portable.mjs <portable.exe> <new-report-directory>');
const executable = resolve(process.argv[2]), directory = resolve(process.argv[3]);
const verified = await verifiedArtifact(executable, { requireIsolatedProfile: true });
await mkdir(directory, { recursive: false });
const folder = await mkdtemp(join(tmpdir(), 'comms packaged café '));
const profile = join(folder, 'profile'), working = join(folder, 'unrelated working directory');
await mkdir(profile); await mkdir(working);
const report = { schemaVersion: 1, artifact: basename(executable), sha256: verified.sha256, startedAt: new Date().toISOString(), status: 'running',
  platform: process.platform, checks: [], claims: { automatedPortableExecution: false, cleanWindows: false, networkIsolation: false, leagueIntegration: false, physicalAudioTiming: false } };
let app;
const errors = [];
const run = promisify(execFile);
const env = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith('COMMS_TEST_') || name === 'ELECTRON_RUN_AS_NODE' || name === 'NODE_OPTIONS') delete env[name];

async function waitState(window, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await window.evaluate(() => window.review.snapshot());
    if (state.error || state.library?.error) throw new Error(state.error ?? state.library.error);
    if (predicate(state)) return state;
    await delay(50);
  }
  throw new Error(`Packaged workflow timed out: ${JSON.stringify(state)}`);
}

async function launch(path = executable) {
  app = await launchDesktop({ executable: path, cwd: working, profile, env, verifyIdentity: async identity => {
    assert.equal(identity.packaged, true, 'A development Electron launch cannot verify the portable application');
    assert.equal(resolve(identity.userData).toLowerCase(), resolve(profile).toLowerCase(), 'Packaged app did not use the isolated review library');
    assert.equal(resolve(identity.sessionData).toLowerCase(), resolve(profile).toLowerCase(), 'Chromium profile was not isolated');
    assert.equal(resolve(identity.portableExecutable).toLowerCase(), resolve(path).toLowerCase(), 'Unexpected portable launcher');
    assert.equal(await digestFile(identity.executable), verified.payloadFiles['League Replay Comms.exe'], 'Another application executable was launched');
    assert.equal(await digestFile(join(identity.resources, 'app.asar')), verified.payloadFiles['resources/app.asar'], 'Running ASAR differs from the verified portable payload');
  } });
  const { identity } = app;
  const window = await app.firstWindow();
  window.setDefaultTimeout(30_000);
  window.on('pageerror', error => errors.push(error.message));
  await window.locator('#task-title').waitFor();
  await waitState(window, state => !!state.library);
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await window.evaluate(() => typeof window.process), 'undefined');
  return { window, identity };
}
async function selectFile(window, path, button) {
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path);
  await window.getByRole('button', { name: button, exact: true }).click();
}
async function close() { await app.close(); app = undefined; }

try {
  let { window, identity } = await launch();
  report.version = identity.version; report.electron = identity.electron; report.checks.push('portable-launch-and-payload-identity', 'loopback-debugger-process-identity', 'isolated-library-and-browser-profile', 'renderer-node-isolation');
  assert.equal((await window.evaluate(() => window.review.snapshot())).replay, undefined, 'Close the League replay before running the isolated package test');
  const audioPath = join(folder, 'comms žaidimas.wav');
  const wav = Buffer.alloc(44 + 48_000 * 2 * 10);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(audioPath, wav);
  await window.evaluate(() => window.review.command({ type: 'workflow', action: 'prepare' }));
  await selectFile(window, audioPath, 'Choose recording');
  await waitState(window, state => !!state.library?.recording?.hash && state.media?.name === basename(audioPath));
  await window.evaluate(async () => {
    await window.review.command({ type: 'volume', volume: 0 });
    await window.review.command({ type: 'seek-preview', positionSeconds: 2.125 });
    await window.review.command({ type: 'preview', paused: false });
  });
  const moving = await waitState(window, state => !state.paused && state.positionSeconds > 2.15);
  assert(moving.audioOutput?.driver && moving.audioOutput.driver !== 'null', 'Packaged playback must use a real output driver');
  report.outputDriver = moving.audioOutput.driver;
  await window.evaluate(() => window.review.command({ type: 'preview', paused: true }));
  await waitState(window, state => state.paused);
  report.checks.push('bundled-probe-and-player', 'unicode-audio-path', 'precise-seek-and-paused-preview');

  const ffmpeg = join(identity.resources, 'bin/win32-x64/ffmpeg.exe');
  assert.equal(await digestFile(ffmpeg), verified.payloadFiles['resources/bin/win32-x64/ffmpeg.exe']);
  let video = join(folder, 'clock and two comms tracks.mkv');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', resolve('tests/fixtures/ocr/clock-video.mkv'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-map', '0:v', '-map', '1:a', '-map', '1:a', '-t', '4', '-vf', 'scale=68:26:flags=lanczos,pad=1920:1080:1852:0:color=0x111827', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '1', '-c:a', 'pcm_s16le', video], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
  await window.evaluate(() => window.review.command({ type: 'workflow', action: 'change-recording' }));
  await selectFile(window, video, 'Choose recording');
  const opened = await waitState(window, state => state.media?.name === basename(video) && !!state.library?.recording?.hash);
  assert.equal(opened.media.tracks.length, 2);
  await window.evaluate(async () => {
    await window.review.command({ type: 'cancel-clock' });
    await window.review.command({ type: 'align', offsetSeconds: 3 });
    await window.review.command({ type: 'analyze-clock' });
  });
  const clock = await waitState(window, state => state.library?.clock?.status === 'accepted' || state.library?.clock?.status === 'needs-attention', 180_000);
  assert.equal(clock.library.clock.status, 'accepted', clock.library.clock.message);
  assert(Math.abs(clock.library.clock.offsetSeconds + 100) < 0.06);
  assert(Math.abs(clock.offsetSeconds + 100) < 0.06, 'Explicit reanalysis must apply the clock midpoint');
  assert.equal(clock.library.boundToRuntime, false, 'Automatic alignment must not start listening');
  report.checks.push('packaged-decoder-and-offline-ocr-resources', 'automatic-midpoint-alignment');
  const track = opened.media.tracks[1].id;
  await window.evaluate(async id => {
    await window.review.command({ type: 'track', trackId: id });
    await window.review.command({ type: 'align', offsetSeconds: 3.125 });
    await window.review.command({ type: 'nudge', deltaSeconds: 0.01 });
    await window.review.command({ type: 'volume', volume: 37 });
  }, track);
  const saved = await waitState(window, state => state.paused && state.media.selectedTrackId === track && Math.abs(state.offsetSeconds - 3.135) < 1e-8 && !state.library.saveError);
  const recordingHash = saved.library.recording.hash;

  await app.evaluate(({ shell }) => { globalThis.packagedNoticePaths = []; globalThis.originalNoticeOpen = shell.openPath; shell.openPath = async path => { globalThis.packagedNoticePaths.push(path); return ''; }; });
  try {
    await window.evaluate(() => window.review.command({ type: 'open-notices' }));
    const paths = await app.evaluate(() => globalThis.packagedNoticePaths);
    assert.deepEqual(paths, [join(identity.resources, 'notices/THIRD_PARTY_NOTICES.html')]);
    assert.equal(await digestFile(paths[0]), verified.payloadFiles['resources/notices/THIRD_PARTY_NOTICES.html']);
  } finally { await app.evaluate(({ shell }) => { shell.openPath = globalThis.originalNoticeOpen; }); }
  await window.screenshot({ path: join(directory, 'packaged-review.png'), fullPage: true });
  await close();

  const renamedVideo = join(folder, 'renamed comms café.mkv'); await rename(video, renamedVideo); video = renamedVideo;
  const renamedExe = join(folder, 'renamed companion café.exe'); await copyFile(executable, renamedExe);
  assert.equal(await digestFile(renamedExe), verified.sha256);
  ({ window, identity } = await launch(renamedExe));
  await window.evaluate(async id => { await window.review.command({ type: 'workflow', action: 'prepare' }); await window.review.command({ type: 'select-recording', id }); }, `media:${recordingHash}`);
  const restored = await waitState(window, state => state.library?.recording?.hash === recordingHash && state.media?.selectedTrackId === track && Math.abs(state.offsetSeconds - 3.135) < 1e-8);
  assert.equal(restored.library.volume, 37); assert.equal(restored.paused, true);
  report.checks.push('fixed-packaged-notice-route', 'two-track-alignment-and-volume', 'normal-close-save', 'recording-and-executable-rename-restoration');
  assert.deepEqual(errors, []);
  await close();
  report.status = 'passed'; report.claims.automatedPortableExecution = true;
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (app) await close().catch(error => { report.status = 'failed'; report.claims.automatedPortableExecution = false; report.cleanupError = String(error); });
  report.finishedAt = new Date().toISOString();
  try { await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { report.status = 'failed'; report.claims.automatedPortableExecution = false; report.cleanupError = String(error); }
  await writeFile(join(directory, 'portable-execution.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
assert.equal(report.status, 'passed', report.cleanupError);
console.log(`Verified automated portable workflow for SHA-256 ${verified.sha256}. Clean-Windows, network-isolation, League, and audible timing checks remain separate.`);
