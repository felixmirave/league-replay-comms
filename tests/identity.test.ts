import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identifyFile } from '../src/library/identity';
import { HashWorkers } from '../src/analysis/hash-client';

let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'comms-identity-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

describe('content identity', () => {
  it('hashes exact bytes and recognizes a copied file independently of its path', async () => {
    const path = join(folder, 'original');
    const copy = join(folder, 'renamed copy');
    const contents = Buffer.alloc(2_000_000, 127);
    await writeFile(path, contents);
    await copyFile(path, copy);
    const first = await identifyFile(path);
    const second = await identifyFile(copy);
    expect(first.sha256).toBe(createHash('sha256').update(contents).digest('hex'));
    expect(second.sha256).toBe(first.sha256);
    expect(second.path).not.toBe(first.path);
  });

  it('rejects contents modified during hashing', async () => {
    const path = join(folder, 'changing');
    await writeFile(path, Buffer.alloc(3_000_000));
    let changed = false;
    await expect(identifyFile(path, undefined, () => { if (!changed) { changed = true; appendFileSync(path, 'new bytes'); } })).rejects.toThrow('changed');
  });

  it('cancels a running read instead of publishing a partial digest', async () => {
    const path = join(folder, 'cancelled');
    await writeFile(path, Buffer.alloc(3_000_000));
    const abort = new AbortController();
    await expect(identifyFile(path, abort.signal, () => abort.abort())).rejects.toThrow();
  });

  it('runs hashing in real bounded workers and cancels queued work', async () => {
    const workerPath = join(folder, 'hash.cjs');
    await build({ entryPoints: [resolve('src/analysis/hash-entry.ts')], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs' });
    const path = join(folder, 'recording');
    await writeFile(path, Buffer.alloc(3_000_000, 31));
    const workers = new HashWorkers(workerPath, 1);
    try {
      const first = workers.identify(path);
      const abort = new AbortController();
      const second = workers.identify(path, abort.signal);
      const cancelled = expect(second).rejects.toThrow('cancelled');
      abort.abort();
      const result = await first;
      await cancelled;
      expect(result.sha256).toBe((await identifyFile(path)).sha256);
    } finally { await workers.close(); }
  });
});
