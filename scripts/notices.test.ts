import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareNotices, verifyNotices } from './notices.ts';

const notice = Buffer.from('Copyright Example\nPermission is granted. <script>must remain text</script>\n');
const hash = createHash('sha256').update(notice).digest('hex');

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'comms-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'scripts/notices-manifest.json': {
      schemaVersion: 1, requirements: { packages: { bundled: '1.0.0' }, nativeArtifacts: { player: 'a'.repeat(64) } },
      components: [{ id: 'bundled', name: 'Bundled <component>', version: '1.0.0', npmPackage: 'bundled' as string | undefined,
        sourceUrl: 'https://example.com/source', notes: ['Later license provenance remains explicit.'],
        files: [{ name: 'LICENSE.txt', url: 'https://example.com/LICENSE', sha256: hash }] }],
      unresolved: ['Corresponding source remains unresolved.'],
    },
    'resources/native-manifest.json': { artifacts: [{ name: 'player', sha256: 'a'.repeat(64) }] },
    'package-lock.json': { packages: { '': {}, 'node_modules/bundled': { version: '1.0.0' },
      'node_modules/transitive': { version: '2.0.0', resolved: 'https://example.com/transitive.tgz' },
      'node_modules/dev-only': { version: '3.0.0', dev: true } } },
    'node_modules/bundled/package.json': { name: 'bundled', version: '1.0.0' },
    'node_modules/transitive/package.json': { name: 'transitive', version: '2.0.0' },
  };
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(value));
  }
  await writeFile(join(root, 'node_modules/transitive/LICENCE'), notice);
  return { root, manifest: files['scripts/notices-manifest.json'] };
}

test('notices preserve transitive attribution, pinned supplements and qualified provenance offline', async t => {
  const { root } = await fixture(t);
  let requests = 0;
  const inventory = await prepareNotices({ root, fetchBytes: async () => { requests++; return notice; } });
  assert.equal(requests, 1);
  assert.equal(inventory.components.length, 2);
  assert.equal(inventory.components[1]!.name, 'transitive');
  const page = await readFile(join(root, 'resources/notices/THIRD_PARTY_NOTICES.html'), 'utf8');
  assert.match(page, /Corresponding source remains unresolved/);
  assert.match(page, /Later license provenance remains explicit/);
  assert.match(page, /&lt;script&gt;must remain text&lt;\/script&gt;/);
  assert.doesNotMatch(page, /<script>/);
  assert.deepEqual(await verifyNotices(root), inventory);
  const offline = await prepareNotices({ root, fetchBytes: () => { throw new Error('Unexpected network request'); } });
  assert.deepEqual(offline, inventory, 'The same inputs produce identical output without downloading again');
});

test('failed or corrupt notice acquisition preserves the last prepared inventory', async t => {
  const { root } = await fixture(t);
  await prepareNotices({ root, fetchBytes: async () => notice });
  const before = await readFile(join(root, 'resources/notices/verified.json'));
  await writeFile(join(root, '.cache/notices', hash), 'corrupt cached download');
  await assert.rejects(prepareNotices({ root, fetchBytes: async () => Buffer.from('incorrect response') }), /checksum mismatch/);
  assert.deepEqual(await readFile(join(root, 'resources/notices/verified.json')), before);
  await verifyNotices(root);
});

test('verification rejects a changed notice, missing pinned file, and stale dependency lock', async t => {
  const { root } = await fixture(t);
  await prepareNotices({ root, fetchBytes: async () => notice });
  const target = join(root, 'resources/notices/upstream/bundled/LICENSE.txt');
  await writeFile(target, 'altered');
  await assert.rejects(verifyNotices(root), /Notice changed after preparation/);
  await writeFile(target, notice);
  const inventoryPath = join(root, 'resources/notices/verified.json');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  delete inventory.files['upstream/bundled/LICENSE.txt'];
  await writeFile(inventoryPath, JSON.stringify(inventory));
  await assert.rejects(verifyNotices(root), /Pinned notice absent/);
  await prepareNotices({ root });
  const lockPath = join(root, 'package-lock.json');
  await writeFile(lockPath, `${await readFile(lockPath, 'utf8')}\n`);
  await assert.rejects(verifyNotices(root), /Stale notices/);
});

test('preparation refuses unaudited version changes and unsafe or duplicate Windows paths before downloads', async t => {
  const { root, manifest } = await fixture(t);
  const path = join(root, 'scripts/notices-manifest.json');
  let requests = 0;
  const fetchBytes = async () => { requests++; return notice; };
  manifest.requirements.packages.bundled = '2.0.0';
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(prepareNotices({ root, fetchBytes }), /Notice audit must be updated/);
  manifest.requirements.packages.bundled = '1.0.0';
  for (const name of ['../escape', 'C:escape', 'NUL.txt']) {
    manifest.components[0]!.files[0]!.name = name;
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(prepareNotices({ root, fetchBytes }), /filename/);
  }
  manifest.components[0]!.files[0]!.name = 'LICENSE.txt';
  manifest.components[0]!.files.push({ ...manifest.components[0]!.files[0]!, name: 'license.TXT' });
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(prepareNotices({ root, fetchBytes }), /Duplicate notice file/);
  assert.equal(requests, 0);
});

test('production packages without a collected license require an explicit versioned supplement', async t => {
  const { root, manifest } = await fixture(t);
  delete manifest.components[0]!.npmPackage;
  await writeFile(join(root, 'scripts/notices-manifest.json'), JSON.stringify(manifest));
  await assert.rejects(prepareNotices({ root, fetchBytes: async () => notice }), /No full notice collected for bundled@1.0.0/);
});
