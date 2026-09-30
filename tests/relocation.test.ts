import { mkdtemp, writeFile, rm, rename, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identifyFile } from '../src/library/identity';
import { relocateFile } from '../src/library/relocation';

describe('recording relocation', () => {
  it('finds renamed bytes in a configured folder and rejects same-size replacements', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'comms-relocation-'));
    try {
      const original = join(folder, 'old', 'recording.wav');
      const moved = join(folder, 'new', 'renamed.wav');
      await mkdir(join(folder, 'old')); await mkdir(join(folder, 'new'));
      await writeFile(original, 'same recording');
      const identity = await identifyFile(original);
      const file = { hash: identity.sha256, name: 'recording.wav', size: identity.version.size, locations: [identity] };
      await rename(original, moved);
      await writeFile(original, 'different data');
      let verified = 0;
      const found = await relocateFile(file, [join(folder, 'new')], async path => { verified++; return identifyFile(path); });
      expect(found?.path).toBe(moved);
      expect(verified).toBeGreaterThanOrEqual(2);
      await rm(moved);
      expect(await relocateFile(file, [], identifyFile)).toBeUndefined();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('bounds directory traversal and does not follow symlink cycles', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'comms-relocation-'));
    try {
      const path = join(folder, 'recording');
      await writeFile(path, 'target');
      const identity = await identifyFile(path);
      await rm(path);
      if (process.platform !== 'win32') await symlink(folder, join(folder, 'loop'));
      const file = { hash: identity.sha256, name: 'recording', size: identity.version.size, locations: [identity] };
      expect(await relocateFile(file, [folder], identifyFile, undefined, 5)).toBeUndefined();
      const abort = new AbortController(); abort.abort();
      await expect(relocateFile(file, [folder], identifyFile, abort.signal)).rejects.toThrow();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});
