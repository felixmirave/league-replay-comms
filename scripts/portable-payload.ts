import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import sevenZip from '7zip-bin';

const run = promisify(execFile);

async function inventory(root: string, prefix = '', entries = new Map<string, { directory: boolean; size: number }>()) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    assert(!entry.name.includes('\\') && !/[\r\n]/.test(entry.name), `Unsupported packaged path: ${path}`);
    assert(entry.isFile() || entry.isDirectory(), `Packaged path is not a regular file/directory: ${path}`);
    const size = entry.isDirectory() ? 0 : (await stat(join(root, path))).size;
    entries.set(path, { directory: entry.isDirectory(), size });
    if (entry.isDirectory()) await inventory(root, `${path}/`, entries);
  }
  return entries;
}

export function verifyArchiveListing(listing: string, staged: ReadonlyMap<string, { directory: boolean; size: number }>) {
  const entriesText = listing.replaceAll('\r\n', '\n').split('\n----------\n');
  assert.equal(entriesText.length, 2, 'Unexpected embedded archive listing');
  if (entriesText[0]!.includes('WARNINGS:')) assert(entriesText[0]!.includes('WARNINGS:\nThere are data after the end of archive\n'), 'Unexpected embedded archive warning');
  const entries = entriesText[1]!.replace(/\n\n+Warnings: 1\n*$/, '\n');
  const seen = new Set<string>(), caseFolded = new Set<string>();
  for (const block of entries.split(/\n\n+/).filter(value => value.trim())) {
    const fields = new Map(block.split('\n').filter(Boolean).map(line => {
      const separator = line.indexOf(' = ');
      assert(separator > 0, 'Invalid archive listing field');
      return [line.slice(0, separator), line.slice(separator + 3)];
    }));
    const name = fields.get('Path')?.replaceAll('\\', '/');
    assert(name && !name.startsWith('/') && !name.includes(':') && name.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe archive path: ${name}`);
    assert(!caseFolded.has(name.toLowerCase()), `Duplicate Windows archive path: ${name}`);
    assert(!fields.has('Symbolic Link') && !fields.has('Hard Link'), `Archive contains a link: ${name}`);
    assert.equal(fields.get('Encrypted'), '-', `Encrypted archive entry: ${name}`);
    const expected = staged.get(name);
    assert(expected, `Unexpected embedded payload entry: ${name}`);
    assert.equal(Number(fields.get('Size')), expected.size, `Embedded payload size differs: ${name}`);
    const isDirectory = fields.get('Folder') === '+' || /^D/.test(fields.get('Attributes') ?? '');
    assert.equal(isDirectory, expected.directory, `Embedded payload type differs: ${name}`);
    caseFolded.add(name.toLowerCase()); seen.add(name);
  }
  assert.deepEqual([...seen].sort(), [...staged.keys()].sort(), 'Embedded payload entry set differs from staged build');
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyPortablePayload(executable: string, stagedRoot: string, cacheRoot = '.cache') {
  if (process.platform !== 'win32') await chmod(sevenZip.path7za, 0o755);
  const expected = await inventory(stagedRoot);
  const options = { windowsHide: true, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 };
  const { stdout } = await run(sevenZip.path7za, ['l', '-slt', resolve(executable)], options);
  // NSIS portable files have bytes before/after their embedded 7z payload. The
  // upstream tool detects that payload; its normal trailing-data warning is expected.
  // Validate names and sizes before extraction, and compare actual bytes afterwards.
  verifyArchiveListing(stdout, expected);
  await mkdir(cacheRoot, { recursive: true });
  const extracted = await mkdtemp(join(resolve(cacheRoot), 'portable-verification-'));
  try {
    await run(sevenZip.path7za, ['x', resolve(executable), `-o${extracted}`, '-y'], options);
    const actual = await inventory(extracted);
    assert.deepEqual([...actual].sort(([a], [b]) => a.localeCompare(b)), [...expected].sort(([a], [b]) => a.localeCompare(b)), 'Extracted payload tree differs from staged build');
    const files: Record<string, string> = {};
    for (const [name, entry] of expected) {
      if (entry.directory) continue;
      const [source, payload] = await Promise.all([hashFile(join(stagedRoot, name)), hashFile(join(extracted, name))]);
      assert.equal(payload, source, `Embedded payload bytes differ: ${name}`);
      files[name] = payload;
    }
    return files;
  } finally { await rm(extracted, { recursive: true, force: true }); }
}
