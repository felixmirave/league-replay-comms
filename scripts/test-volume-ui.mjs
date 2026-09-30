import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';

// Exercise the actual renderer and native range input. The desktop boundary is
// controlled so old snapshots and delayed command replies arrive deterministically.
let folder, app, page, errors;
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'comms-volume-'));
  await build({ entryPoints: ['src/renderer/main.tsx'], outfile: join(folder, 'renderer.js'), bundle: true, define: { 'process.env.NODE_ENV': '"production"' } });
  await writeFile(join(folder, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => { const window = new BrowserWindow({ width: 780, height: 820 }); window.loadURL('about:blank'); });`);
  app = await electron.launch({ executablePath, args: [join(folder, 'main.cjs'), `--user-data-dir=${join(folder, 'profile')}`, ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
});
after(async () => {
  try { await app?.close(); } finally { if (folder) await rm(folder, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
});
beforeEach(async () => {
  await page.reload();
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    window.volumeTest = {
      state: { workflow: { state: 'listening', primary: 'Stop listening' }, sync: { state: 'following', generation: 1 }, paused: false, busy: false,
        replay: { timeSeconds: 125.123, speed: 1 }, library: { recordings: [], mediaGeneration: 1, recordingReady: true, trackChosen: true, volume: 100, folders: [], warnings: [], missingRecording: false } },
      calls: [],
      publish(volume) {
        if (volume !== undefined) this.state.library.volume = volume;
        this.state.replay.timeSeconds += 0.017;
        this.listener(structuredClone(this.state));
      },
    };
    window.review = {
      snapshot: async () => structuredClone(window.volumeTest.state), preview: async () => ({ revision: 0, mediaGeneration: 0 }),
      subscribe: listener => { window.volumeTest.listener = listener; return () => {}; }, subscribePreview: () => () => {},
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
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function tick(volume) { await page.evaluate(value => window.volumeTest.publish(value), volume); await paint(); }
async function reply(index, volume, error) {
  await page.evaluate(({ index, volume, error }) => {
    window.volumeTest.publish(volume);
    const call = window.volumeTest.calls[index];
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
  const clockBefore = await page.locator('.replay-clock').innerText();
  await page.evaluate(() => {
    const input = document.querySelector('.task input[type=range]');
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
  const sent = await page.evaluate(() => window.volumeTest.calls.map(call => call.command.volume));
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
