import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { sameFileVersion, type FileVersion, type FileIdentity } from './model';

function version(stats: BigIntStats): FileVersion {
  const size = Number(stats.size);
  if (!stats.isFile() || !Number.isSafeInteger(size)) throw new Error('Choose a regular file with a supported size');
  return { size, mtimeNs: stats.mtimeNs.toString(), ctimeNs: stats.ctimeNs.toString(), device: stats.dev.toString(), inode: stats.ino.toString() };
}
export async function fileVersion(path: string): Promise<FileVersion> { return version(await stat(path, { bigint: true })); }

/** Run in the hash worker. Memory is bounded independently of recording length. */
export async function identifyFile(path: string, signal?: AbortSignal, progress?: (completed: number, total: number) => void): Promise<FileIdentity> {
  signal?.throwIfAborted();
  const absolute = resolve(path);
  const file = await open(absolute, 'r');
  try {
    const before = version(await file.stat({ bigint: true }));
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let completed = 0;
    let lastProgress = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      completed += bytesRead;
      if (performance.now() - lastProgress >= 100) { progress?.(completed, before.size); lastProgress = performance.now(); }
    }
    signal?.throwIfAborted();
    const after = version(await file.stat({ bigint: true }));
    const atPath = await fileVersion(absolute);
    if (completed !== before.size || !sameFileVersion(before, after) || !sameFileVersion(before, atPath)) throw new Error('The file changed while being identified. Finish recording or copying it and try again.');
    progress?.(completed, before.size);
    return { path: absolute, sha256: hash.digest('hex'), version: after, verifiedAt: new Date().toISOString() };
  } finally { await file.close(); }
}
