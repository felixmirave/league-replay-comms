import type { OpenVolumeBackend, VolumeBackend } from './volume-backend-types.ts';
import type { UserCommand } from '../src/shared/protocol';
import type { ElectronApplication, Page } from 'playwright-core';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright-core';
import executablePath from './electron-executable.ts';

// Exercise the actual renderer and native range input. The desktop boundary is
// controlled so old snapshots and delayed command replies arrive deterministically.
let folder: string, app: ElectronApplication, page: Page;
const errors: string[] = [];
let openVolumeBackend: OpenVolumeBackend;
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'comms-volume-'));
  await build({ entryPoints: ['scripts/fixtures/volume-backend.ts'], outfile: join(folder, 'backend.mjs'), bundle: true, platform: 'node', format: 'esm' });
  ({ openVolumeBackend } = await import(pathToFileURL(join(folder, 'backend.mjs')).href));
  await build({ entryPoints: ['src/renderer/main.tsx'], outfile: join(folder, 'renderer.js'), bundle: true, define: { 'process.env.NODE_ENV': '"production"' } });
  await build({ entryPoints: ['scripts/fixtures/blank-window.ts'], outfile: join(folder, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  app = await electron.launch({ executablePath, args: [join(folder, 'main.cjs'), `--user-data-dir=${join(folder, 'profile')}`, ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
});
after(async () => {
  try { await app?.close(); } finally { if (folder) await rm(folder, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
});
beforeEach(async () => {
  // Navigate to a real document: document.open() in setContent can lose native
  // range-input pointer capture in Electron even though mouse events arrive.
  await page.goto('data:text/html,<div id="root"></div>');
  await page.evaluate(() => {
    window.volumeTest = {
      state: { workflow: { state: 'listening', primary: 'Stop listening', revision: 0, editorKey: 1, canReturn: false }, sync: { state: 'following', reason: 'Fixture', generation: 1 }, paused: false, busy: false,
        replay: { sessionId: 'fixture', seeking: false, lengthSeconds: 3000, sentAtSeconds: 0, receivedAtSeconds: 0, timeSeconds: 125.123, speed: 1, paused: false }, library: { recordings: [], mediaGeneration: 1, recordingReady: true, trackChosen: true, volume: 100, folders: [], warnings: [], missingRecording: false } },
      calls: [], listener: () => {},
      publish(volume) {
        if (volume !== undefined) this.state.library.volume = volume;
        this.state.replay.timeSeconds += 0.017;
        this.listener(structuredClone(this.state));
      },
    };
    globalThis.window.review = {
      openDropped: async () => {},
      snapshot: async () => structuredClone(window.volumeTest.state),
      subscribe: listener => { window.volumeTest.listener = listener; return () => {}; },
      command: command => new Promise((resolve, reject) => window.volumeTest.calls.push({ command, resolve, reject })),
    };
  });
  await page.addStyleTag({ path: join(folder, 'renderer.css') });
  await page.addScriptTag({ path: join(folder, 'renderer.js') });
  await slider().waitFor();
  await paint();
});

const slider = () => page.locator('.task input[type=range]');
const settingsSlider = () => page.getByRole('dialog').getByRole('slider', { name: 'Comms volume' });
const stop = () => page.getByRole('button', { name: 'Stop listening', exact: true });
const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function tick(volume?: number) { await page.evaluate(value => window.volumeTest.publish(value), volume); await paint(); }
async function reply(index: number, volume?: number, error?: string) {
  await page.evaluate(({ index, volume, error }) => {
    window.volumeTest.publish(volume);
    const call = window.volumeTest.calls[index]!;
    if (error) call.reject(new Error(error)); else call.resolve();
  }, { index, volume, error });
  await paint();
}

test('keyboard volume stays at the latest input across clock ticks and older replies', async () => {
  await slider().focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await slider().inputValue(), '99');
  await tick();
  assert.equal(await slider().inputValue(), '99');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await slider().inputValue(), '98');
  assert.deepEqual(await page.evaluate(() => window.volumeTest.calls.map(call => call.command)), [{ type: 'volume', volume: 99 }, { type: 'volume', volume: 98 }]);
  await reply(0, 99);
  assert.equal(await slider().inputValue(), '98', 'An older acknowledgement must not move the slider');
  await reply(1, 98);
  assert.equal(await slider().inputValue(), '98');
  await tick(42);
  assert.equal(await slider().inputValue(), '42', 'Idle controls should follow the saved volume');
});

test('volume changes never flash unrelated buttons into their disabled state', async () => {
  await slider().focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await stop().isEnabled(), true);
  await reply(0, 99);
  assert.equal(await stop().isEnabled(), true);
  // Foreground operations must still disable controls while they are pending.
  await stop().click();
  assert.equal(await stop().isDisabled(), true);
  await reply(1);
  assert.equal(await stop().isEnabled(), true);
  await page.evaluate(() => { window.volumeTest.state.busy = true; window.volumeTest.publish(); });
  await paint();
  assert.equal(await stop().isDisabled(), true);
});

test('pointer dragging keeps the thumb under the pointer while the replay clock changes', async () => {
  const bounds = await slider().boundingBox();
  assert(bounds, 'Volume slider has no layout');
  const clockBefore = await page.locator('.replay-clock').innerText();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.task input[type=range]');
    if (!input) throw new Error('Volume slider is missing');
    window.volumeTest.input = input;
    input.addEventListener('input', () => { window.volumeTest.inputValue = input.value; });
  });
  await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + bounds.height / 2);
  await page.mouse.down();
  try {
    for (const fraction of [0.8, 0.6, 0.4, 0.2]) {
      await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * fraction, bounds.y + bounds.height / 2);
      const value = await page.evaluate(() => window.volumeTest.inputValue);
      assert(value, 'The drag must produce a native input event');
      await tick();
      assert.equal(await slider().inputValue(), value, 'A clock tick must not move the thumb away from the pointer');
      assert.equal(await stop().isEnabled(), true);
      assert.equal(await page.evaluate(() => document.activeElement === window.volumeTest.input && document.querySelector('.task input[type=range]') === window.volumeTest.input), true);
      assert.deepEqual(await slider().boundingBox(), bounds);
    }
  } finally { await page.mouse.up(); }
  const sent = await page.evaluate(() => window.volumeTest.calls.map(call => call.command.type === 'volume' ? call.command.volume : undefined));
  assert(sent.length >= 4);
  const latest = String(sent.at(-1));
  for (const [index, value] of sent.entries()) { await reply(index, value); assert.equal(await slider().inputValue(), latest); }
  assert.notEqual(await page.locator('.replay-clock').innerText(), clockBefore);
});

test('Settings and listening share pending volume, including mute and full volume', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSlider().focus();
  await page.keyboard.press('Home');
  await tick();
  assert.equal(await settingsSlider().inputValue(), '0');
  assert.equal(await slider().inputValue(), '0');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await slider().focus();
  await page.keyboard.press('End');
  await reply(0, 0);
  assert.equal(await slider().inputValue(), '100');
  await reply(1, 100);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await settingsSlider().inputValue(), '100');
  await tick(37);
  assert.equal(await settingsSlider().inputValue(), '37');
  assert.equal(await slider().inputValue(), '37');
});

test('a failed volume command reports its error and reconciles with the backend', async () => {
  await slider().focus();
  await page.keyboard.press('Home');
  await reply(0, 100, 'Playback process unavailable');
  assert.equal(await slider().inputValue(), '100');
  assert.equal(await page.locator('.task [role=alert]').innerText(), 'Playback process unavailable');
  await page.keyboard.press('ArrowLeft');
  // A save failure may still retain the volume intent for the current session.
  await reply(1, 99, 'Volume could not be saved');
  assert.equal(await slider().inputValue(), '99');
  assert.equal(await page.locator('.task [role=alert]').innerText(), 'Volume could not be saved');
  await page.keyboard.press('ArrowLeft');
  await reply(2, 98);
  assert.equal(await page.locator('.task [role=alert]').count(), 0);
  assert.equal(await slider().inputValue(), '98');
});

test('a failed older command cannot overwrite a newer volume edit', async () => {
  await slider().focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await reply(0, 99, 'Earlier save failed');
  assert.equal(await slider().inputValue(), '98');
  assert.equal(await page.locator('.task [role=alert]').count(), 0);
  await reply(1, 98);
  assert.equal(await slider().inputValue(), '98');
});

test('real volume saves keep the layout stable while actual failures remain retryable', async () => {

  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  let session: VolumeBackend['session'] | undefined;
  const publish = async () => {
    if (session) await page.evaluate(view => {
      Object.assign(window.volumeTest.state.library, view, { recordingReady: true });
      window.volumeTest.publish();
    }, session.snapshot());
  };
  const backend = await openVolumeBackend(join(folder, 'library'), () => { void publish(); });
  session = backend.session;
  const library = backend.library;
  const persist = library.updateSettings.bind(library);
  library.updateSettings = async value => { started(); await gate; await persist(value); };
  await page.exposeFunction('persistVolume', (command: UserCommand) => command.type === 'retry-save' ? session!.retrySave() : command.type === 'volume' ? session!.setVolume(command.volume) : Promise.reject(new Error('Unexpected volume fixture command')));
  await page.evaluate(() => { globalThis.window.review.command = command => window.persistVolume(command); });
  await publish(); await paint();
  const bounds = await page.locator('.task').boundingBox();
  try {
    await slider().focus();
    await page.keyboard.press('ArrowLeft');
    await writing;
    assert.equal(session.snapshot().unsavedPreferences, 1, 'Exercise a real pending preference write');
    for (let i = 0; i < 5; i++) {
      await publish(); await paint();
      assert.equal(await page.locator('.context .notice').count(), 0, 'A pending successful save must not be presented as a failure');
      assert.deepEqual(await page.locator('.task').boundingBox(), bounds, 'Saving must not shift the page');
      assert.equal(await slider().inputValue(), '99');
      assert.equal(await stop().isEnabled(), true);
    }
    release(); await session.settled(); await publish(); await paint();
    assert.equal(library.snapshot().settings.volume, 99);
    assert.equal(await page.locator('.context .notice').count(), 0);
    library.updateSettings = async () => { throw new Error('Volume disk unavailable'); };
    await page.keyboard.press('ArrowLeft');
    await page.locator('.context .notice').waitFor();
    assert.match(await page.locator('.context .notice').textContent() ?? '', /Volume disk unavailable/);
    assert.equal(await slider().inputValue(), '98');
    library.updateSettings = persist;
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await page.locator('.context .notice').waitFor({ state: 'detached' });
    assert.equal(library.snapshot().settings.volume, 98);
    assert.deepEqual(await page.locator('.task').boundingBox(), bounds);
  } finally {
    release(); await session.settled(); await publish(); await paint(); session.close();
  }
});
