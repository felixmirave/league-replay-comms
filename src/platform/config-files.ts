import { lstat, open, stat } from 'node:fs/promises';

/** Bounded stable read; neither a growing file nor a named pipe can become input. */
export async function readConfigBytes(path: string, limit = 1024 * 1024): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile()) throw new Error('Configuration must be a regular file, not a directory or symbolic link.');
  const file = await open(path, 'r');
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > limit) throw new Error('Configuration or backup exceeds its size limit.');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const observations = await Promise.all([file.stat({ bigint: true }), stat(path, { bigint: true })]);
    if (total !== Number(before.size) || observations.some(after => (['size', 'dev', 'ino', 'mtimeNs', 'ctimeNs'] as const).some(key => after[key] !== before[key]))) throw new Error('Configuration changed while being read. Refresh after League finishes writing it.');
    return bytes.subarray(0, total);
  } finally { await file.close(); }
}
