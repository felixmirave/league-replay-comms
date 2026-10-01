import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sevenZip from '7zip-bin';
import { verifyArchiveListing, verifyPortablePayload } from './portable-payload.ts';

test('portable verification extracts an embedded payload and detects stale staged bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'comms-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = join(root, 'staged');
  await mkdir(join(staged, 'resources'), { recursive: true });
  await writeFile(join(staged, 'resources/notice.txt'), 'fixture notice');
  await writeFile(join(staged, 'App.exe'), 'fixture executable');
  if (process.platform !== 'win32') await chmod(sevenZip.path7za, 0o755);
  await promisify(execFile)(sevenZip.path7za, ['a', '-t7z', join(root, 'payload.7z'), '.'], { cwd: staged, windowsHide: true });
  const executable = join(root, 'portable.exe');
  await writeFile(executable, Buffer.concat([Buffer.from('MZ fixture launcher prefix\n'), await readFile(join(root, 'payload.7z')), Buffer.from('\nfixture launcher suffix')]));
  const files = await verifyPortablePayload(executable, staged, root);
  assert.equal(Object.keys(files).length, 2);
  await writeFile(join(staged, 'resources/notice.txt'), 'changed notice');
  await assert.rejects(verifyPortablePayload(executable, staged, root), /Embedded payload bytes differ/);
});

test('listing validation rejects escaping, duplicate, missing and unrelated payload entries', () => {
  const staged = new Map([['license.txt', { directory: false, size: 4 }]]);
  const block = (name: string) => `Path = ${name}\nSize = 4\nAttributes = A\nEncrypted = -\n`;
  const listing = (...names: string[]) => `Header\n----------\n${names.map(block).join('\n')}`;
  verifyArchiveListing(listing('license.txt'), staged);
  for (const name of ['../license.txt', '/license.txt', 'C:\\license.txt']) assert.throws(() => verifyArchiveListing(listing(name), staged), /Unsafe archive path/);
  assert.throws(() => verifyArchiveListing(listing('license.txt', 'LICENSE.TXT'), staged), /Duplicate Windows archive path/);
  assert.throws(() => verifyArchiveListing(listing('unrelated.txt'), staged), /Unexpected embedded payload entry/);
  assert.throws(() => verifyArchiveListing(listing(), staged), /entry set differs/);
});
