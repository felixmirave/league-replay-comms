import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function replace(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (attempt >= 3 || !['EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(50 * 2 ** attempt);
    }
  }
}

/** Never removes the destination to make replacement succeed. */
export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents, 'utf8'); await file.sync(); } finally { await file.close(); }
    await replace(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
