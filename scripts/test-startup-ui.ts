import { build } from 'esbuild';
import type { TestContext } from 'node:test';
import type { ElectronApplication } from 'playwright-core';
import type { ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import executablePath from './electron-executable.ts';

async function launch(t: TestContext, { gate = 'library', fail = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'comms-startup-'));
  const profile = join(folder, 'profile');
  let app: ElectronApplication | undefined, child: ChildProcess | undefined;
  t.after(async () => {
    try {
      if (app && child?.exitCode === null) {
        await app.evaluate(() => globalThis.startupProbe.release()).catch(() => {});
        await app.close();
      }
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  // Hold actual startup I/O in the main process. The shipped app has no delay,
  // failure-injection switch, or alternate IPC path for this test.
  await build({ entryPoints: ['scripts/fixtures/startup-entry.ts'], outfile: join(folder, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  app = await electron.launch({ executablePath, args: [join(folder, 'main.cjs'), `--user-data-dir=${profile}`, ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])], env: { ...process.env, COMMS_TEST_NULL_AUDIO: '1', COMMS_STARTUP_ROOT: process.cwd(), COMMS_STARTUP_PROFILE: profile, COMMS_STARTUP_GATE: gate, COMMS_STARTUP_FAIL: fail ? '1' : '0' } });
  child = app.process();
  const page = await app.firstWindow({ timeout: 10000 });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.getByRole('heading', { name: 'Starting…', exact: true }).waitFor();
  await page.waitForFunction(async () => (await globalThis.window.review.snapshot()).startup === 'loading');
  // Wait until the held I/O is reached without imposing a machine-speed delay.
  const deadline = Date.now() + 10000;
  while (!await app.evaluate(() => globalThis.startupProbe.entered)) {
    assert(Date.now() < deadline, 'Initialization did not reach the I/O barrier');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  assert.equal(await app.evaluate(() => globalThis.startupProbe.visible), true, 'The main window must already be visible when startup I/O begins');
  assert.equal(await page.getByRole('button').count(), 0, 'Controls must wait for service initialization');
  assert.equal(await page.locator('main').getAttribute('aria-busy'), 'true');
  return { app, page, child };
}

test('shows an animated loading screen before slow I/O and then opens the normal interface', { timeout: 30000 }, async t => {
  const { app, page } = await launch(t);
  assert.equal(await page.locator('.startup-logo').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 256), true, 'The packaged logo must load on the startup screen');
  assert.equal(await page.locator('.startup-spinner').evaluate(element => getComputedStyle(element).animationName), 'startup-spin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.startup-spinner').evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const rejected = await page.evaluate(async () => {
    try { await globalThis.window.review.command({ type: 'workflow', action: 'prepare' }); return ''; }
    catch (error) { return String(error); }
  });
  assert.match(rejected, /still starting/);
  await mkdir('.cache', { recursive: true });
  await page.screenshot({ path: '.cache/startup-window.png' });
  await app.evaluate(() => globalThis.startupProbe.release());
  await page.waitForFunction(async () => (await globalThis.window.review.snapshot()).startup === 'ready');
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.locator('.app-brand img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 256), true, 'The logo must remain available in the app header');
  assert.equal(await page.locator('.startup-spinner').count(), 0);
  await page.evaluate(() => globalThis.window.review.command({ type: 'workflow', action: 'prepare' }));
  await page.getByRole('heading', { name: 'Choose your recording', exact: true }).waitFor();
});

test('replaces the loading screen with a visible error when initialization fails', { timeout: 30000 }, async t => {
  const { app, page } = await launch(t, { fail: true });
  await app.evaluate(() => globalThis.startupProbe.release());
  await page.getByRole('heading', { name: 'The application could not start', exact: true }).waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Startup test: library unavailable/);
  assert.equal(await page.locator('.startup-spinner').count(), 0);
  assert.equal((await page.evaluate(() => globalThis.window.review.snapshot())).startup, 'failed');
});

for (const gate of ['library', 'runtime']) test(`closing during ${gate} initialization drains startup and exits`, { timeout: 30000 }, async t => {
  const { app, child } = await launch(t, { gate });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  // The startup barrier must still be holding the process open for cleanup.
  assert.equal(child.exitCode, null);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  const closed = app.waitForEvent('close', { timeout: 10000 });
  await app.evaluate(() => globalThis.startupProbe.release());
  await closed;
  assert.equal(child.exitCode, 0);
});
