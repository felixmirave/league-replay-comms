import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import afterPack from './after-pack.mjs';

test('Windows packaging preserves the linked notices and removes only an identical duplicate', async t => {
  const appOutDir = await mkdtemp(join(tmpdir(), 'comms-package-'));
  t.after(() => rm(appOutDir, { recursive: true, force: true }));
  const duplicate = join(appOutDir, 'LICENSES.chromium.html');
  const retained = join(appOutDir, 'resources/native-docs/vulkan-loader/LICENSES.chromium.html');
  await mkdir(join(retained, '..'), { recursive: true });
  await writeFile(duplicate, 'runtime notices');
  const context = { appOutDir, electronPlatformName: 'win32' };
  await assert.rejects(afterPack(context), { code: 'ENOENT' });
  assert.equal(await readFile(duplicate, 'utf8'), 'runtime notices');
  await writeFile(retained, 'different notices');
  await assert.rejects(afterPack(context), /notices differ/);
  assert.equal(await readFile(duplicate, 'utf8'), 'runtime notices');
  assert.equal(await readFile(retained, 'utf8'), 'different notices');
  await writeFile(retained, 'runtime notices');
  await afterPack(context);
  await assert.rejects(readFile(duplicate), { code: 'ENOENT' });
  assert.equal(await readFile(retained, 'utf8'), 'runtime notices');
});
