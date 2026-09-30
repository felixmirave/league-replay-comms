import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';

const profile = await mkdtemp(join(tmpdir(), 'comms-smoke-'));
const app = await electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`, ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])], env: { ...process.env, COMMS_TEST_USER_DATA: join(profile, 'unused-development-override') } });
try {
  const directories = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }));
  assert.deepEqual(directories, { userData: profile, sessionData: profile });
  const window = await app.firstWindow();
  const errors = [];
  window.on('pageerror', error => errors.push(error.message));
  await window.locator('#task-title').waitFor();
  assert.equal(await window.evaluate(() => typeof window.review?.command), 'function');
  assert.equal(await window.getByRole('button', { name: 'Start listening', exact: true }).count(), 0);
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  await window.getByText('Timing diagnostics', { exact: true }).click();
  assert.equal(await window.getByRole('dialog').isVisible(), true);
  await window.evaluate(async () => {
    try { await window.review.command({ type: 'execute-shell', value: 'invalid' }); throw new Error('Invalid IPC was accepted'); }
    catch (error) { if (String(error).includes('Invalid IPC was accepted')) throw error; }
  });
  // Exercise the actual IPC route without launching a system browser in CI.
  await app.evaluate(({ shell }) => {
    globalThis.commsOriginalOpenPath = shell.openPath;
    globalThis.commsOpenedPaths = [];
    shell.openPath = async path => { globalThis.commsOpenedPaths.push(path); return ''; };
  });
  try {
    await window.getByRole('button', { name: 'Third-party notices', exact: true }).click();
    await window.evaluate(async () => { await window.review.snapshot(); });
    const paths = await app.evaluate(() => globalThis.commsOpenedPaths);
    assert.equal(paths.length, 1);
    assert.equal(paths[0], join(process.cwd(), 'resources/notices/THIRD_PARTY_NOTICES.html'));
    assert.match(await readFile(paths[0], 'utf8'), /Independent JPEG Group/);
  } finally {
    await app.evaluate(({ shell }) => { shell.openPath = globalThis.commsOriginalOpenPath; delete globalThis.commsOriginalOpenPath; delete globalThis.commsOpenedPaths; });
  }
  assert.deepEqual(errors, []);
  await mkdir('.cache', { recursive: true });
  await window.screenshot({ path: '.cache/probe-window.png', fullPage: true });
  console.log('Electron window, preload, controls, diagnostics, fixed offline-notice route, and IPC validation passed.');
} finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
