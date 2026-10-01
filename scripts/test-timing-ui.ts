import type { ElectronApplication, Page } from 'playwright-core';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright-core';
import executablePath from './electron-executable.ts';

// Real renderer with a controlled desktop boundary, including delayed saves and
// clock ticks. Session/controller tests cover the playback side of these edits.
let folder: string, app: ElectronApplication, page: Page;
const errors: string[] = [];
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'comms-timing-'));
  await build({ entryPoints: ['src/renderer/main.tsx'], outfile: join(folder, 'renderer.js'), bundle: true, define: { 'process.env.NODE_ENV': '"production"' } });
  await build({ entryPoints: ['scripts/fixtures/blank-window.ts'], outfile: join(folder, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  app = await electron.launch({ executablePath, args: [join(folder, 'main.cjs'), `--user-data-dir=${join(folder, 'profile')}`, ...(process.env.COMMS_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
  page = await app.firstWindow(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
});
after(async () => {
  try { await app?.close(); } finally { if (folder) await rm(folder, { recursive: true, force: true }); }
  assert.deepEqual(errors, []);
});
beforeEach(async () => {
  await page.reload(); await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    window.timingTest = {
      state: { workflow: { state: 'alignment.manual', editorKey: 1, revision: 0, canReturn: false }, sync: { state: 'following', reason: 'Fixture', generation: 1 }, paused: false, busy: false,
        replay: { sessionId: 'fixture', seeking: false, lengthSeconds: 3000, sentAtSeconds: 0, receivedAtSeconds: 0, timeSeconds: 125.123, speed: 1, paused: false },
        media: { name: 'comms.wav', durationSeconds: 3000, tracks: [{ id: 1, title: 'Comms', language: '', selected: true }], selectedTrackId: 1 },
        library: { recordings: [], mediaGeneration: 1, recordingReady: true, trackChosen: true, boundToRuntime: true,
          alignment: { baseOffsetSeconds: 2.5, correctionSeconds: .01, source: 'manual', revision: 0, updatedAt: '2026-01-01T00:00:00Z' }, volume: 100, folders: [], warnings: [], missingRecording: false } },
      calls: [], listener: () => {},
      publish() { this.state.replay.timeSeconds += .017; this.listener(structuredClone(this.state)); },
    };
    globalThis.window.review = {
      openDropped: async () => {},
      snapshot: async () => structuredClone(window.timingTest.state),
      subscribe: listener => { window.timingTest.listener = listener; return () => {}; },
      command: command => new Promise((resolve, reject) => window.timingTest.calls.push({ command, resolve, reject })),
    };
  });
  await page.addStyleTag({ path: join(folder, 'renderer.css') });
  await page.addScriptTag({ path: join(folder, 'renderer.js') });
  await input().waitFor(); await paint();
});
const input = () => page.getByLabel('Recording offset (seconds)', { exact: true });
const button = (name: string) => page.getByRole('button', { name, exact: true });
const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const calls = () => page.evaluate(() => window.timingTest.calls.map(call => call.command));
async function reply(index: number, error?: string) {
  await page.evaluate(({ index, error }) => {
    const t = window.timingTest, call = t.calls[index]!;
    if (call.command.type === 'align') t.state.library.alignment = { baseOffsetSeconds: call.command.offsetSeconds, correctionSeconds: 0, source: 'manual', revision: 0, updatedAt: '2026-01-01T00:00:00Z' };
    t.publish();
    if (error) call.reject(new Error(error)); else call.resolve();
  }, { index, error });
  await paint();
}

test('live steps combine legacy timing and stay responsive through older saves and clock ticks', async () => {
  assert.equal(await input().inputValue(), '2.51');
  const bounds = await page.locator('.task').boundingBox();
  await button('Forward 0.1 s').click();
  await button('Forward 0.1 s').click();
  assert.equal(await input().inputValue(), '2.71');
  assert.equal(await button('Stop listening').isEnabled(), true);
  for (let n = 0; n < 5; n++) {
    await page.evaluate(() => window.timingTest.publish()); await paint();
    assert.equal(await input().inputValue(), '2.71');
    assert.deepEqual(await page.locator('.task').boundingBox(), bounds);
  }
  await reply(0); assert.equal(await input().inputValue(), '2.71');
  await reply(1); assert.equal(await input().inputValue(), '2.71');
  await button('Back 0.1 s').click({ modifiers: ['Alt'] });
  assert.equal(await input().inputValue(), '2.7');
  assert.deepEqual(await calls(), [2.61, 2.71, 2.7].map(offsetSeconds => ({ type: 'align', offsetSeconds })));
  await reply(2);
});

test('partial signed input survives ticks, invalid values never reach playback, and keyboard steps work', async () => {
  for (const text of ['', '-', '86401', '1:20', 'Infinity']) {
    await input().fill(text); await page.evaluate(() => window.timingTest.publish()); await paint();
    assert.equal(await input().inputValue(), text);
    assert.equal(await button('Done').isDisabled(), true);
  }
  assert.deepEqual(await calls(), []);
  await input().fill('-12.5');
  await input().press('ArrowUp');
  await input().press('Alt+ArrowDown');
  await input().press('Shift+ArrowUp');
  assert.equal(await input().inputValue(), '-11.41');
  assert.deepEqual(await calls(), [-12.5, -12.4, -12.41, -11.41].map(offsetSeconds => ({ type: 'align', offsetSeconds })));
  await input().fill('-');
  for (let i = 0; i < 4; i++) { await reply(i); assert.equal(await input().inputValue(), '-'); }
  assert.equal(await button('Stop listening').isEnabled(), true, 'Incomplete input must not block stopping audio');
});

test('new alignment stays silent until Start, accepts zero, and Done waits for the accepted edit', async () => {
  await page.evaluate(() => {
    const t = window.timingTest; t.state.workflow.editorKey++;
    t.state.library.alignment = undefined; t.state.library.boundToRuntime = false;
    t.state.sync.state = 'preview'; t.publish();
  }); await paint();
  assert.equal(await input().inputValue(), '0');
  assert.deepEqual(await calls(), []);
  await button('Start listening').click();
  assert.deepEqual(await calls(), [{ type: 'align', offsetSeconds: 0 }]);
  await reply(0);
  assert.deepEqual((await calls()).at(-1), { type: 'follow' });
  await reply(1);
  await input().fill('5');
  await button('Done').click();
  assert.equal((await calls()).length, 3);
  await reply(2);
  assert.deepEqual((await calls()).at(-1), { type: 'workflow', action: 'finish-edit' });
  await reply(3);
});

test('a failed save retains the intended offset and Done retries it; older failures cannot replace newer edits', async () => {
  await input().fill('10'); await input().fill('11');
  await reply(0, 'Old write failed');
  assert.equal(await page.locator('.timing-editor [role=alert]').count(), 0);
  await reply(1, 'Disk unavailable');
  assert.equal(await input().inputValue(), '11');
  assert.equal(await page.locator('.timing-editor [role=alert]').innerText(), 'Disk unavailable');
  await button('Done').click();
  assert.deepEqual((await calls()).at(-1), { type: 'align', offsetSeconds: 11 });
  await reply(2);
  assert.deepEqual((await calls()).at(-1), { type: 'workflow', action: 'finish-edit' });
  await reply(3);
});

test('disconnect keeps the editor and offset without automatically restarting audio on reconnect', async () => {
  await input().fill('8'); await reply(0);
  await page.evaluate(() => { const t = window.timingTest; t.state.connectionError = 'Disconnected'; t.state.library.boundToRuntime = false; t.publish(); });
  await paint();
  assert.equal(await button('Start listening').isDisabled(), true);
  await button('Back 0.1 s').click(); await reply(1);
  await page.evaluate(() => { window.timingTest.state.connectionError = undefined; window.timingTest.publish(); }); await paint();
  assert.equal(await input().inputValue(), '7.9');
  assert.equal(await button('Start listening').isEnabled(), true);
  assert.equal((await calls()).some(command => command.type === 'follow'), false);
});

test('clock detection is video-only, respects busy state, and never saves an unaccepted default offset', async () => {
  const detect = button('Detect offset from video clock');
  assert.equal(await detect.count(), 0);
  await page.evaluate(() => {
    const t = window.timingTest;
    t.state.media.probe = { formats: [], streams: [{ type: 'audio', index: 0, codec: 'pcm_s16le' }] }; t.publish();
  }); await paint();
  assert.equal(await detect.count(), 0);
  await page.evaluate(() => {
    const t = window.timingTest; t.state.workflow.editorKey++;
    t.state.media.probe!.streams.push({ type: 'video', index: 1, codec: 'h264' });
    t.state.library.alignment = undefined; t.state.library.boundToRuntime = false;
    t.state.sync.state = 'preview'; t.state.busy = true; t.publish();
  }); await paint();
  assert.equal(await detect.isDisabled(), true);
  await page.evaluate(() => { window.timingTest.state.busy = false; window.timingTest.publish(); }); await paint();
  await detect.click();
  assert.deepEqual(await calls(), [{ type: 'analyze-clock' }]);
  assert.equal(await detect.isDisabled(), true);
  assert.equal(await input().isDisabled(), true);
  await reply(0, 'Recording unavailable');
  assert.equal(await page.locator('.timing-editor [role=alert]').innerText(), 'Recording unavailable');
  assert.equal(await input().inputValue(), '0');
  assert.equal(await detect.isEnabled(), true);
  await detect.click();
  assert.deepEqual(await calls(), [{ type: 'analyze-clock' }, { type: 'analyze-clock' }]);
  await reply(1);
});

test('clock detection accepts incomplete input after a queued manual edit without submitting another offset', async () => {
  await page.evaluate(() => {
    const t = window.timingTest;
    t.state.media.probe = { formats: [], streams: [{ type: 'video', index: 0, codec: 'h264' }] }; t.publish();
  }); await paint();
  await input().fill('8');
  await input().fill('-');
  assert.equal(await button('Done').isDisabled(), true);
  await button('Detect offset from video clock').click();
  assert.deepEqual(await calls(), [{ type: 'align', offsetSeconds: 8 }, { type: 'analyze-clock' }]);
  await reply(0); await reply(1);
  assert.equal(await input().inputValue(), '-');
  assert.equal(await page.locator('.timing-editor [role=alert]').count(), 0);
});
