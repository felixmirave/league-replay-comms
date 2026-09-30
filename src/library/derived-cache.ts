import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './storage';

/** Size-bounded disposable JSON artifacts. Durable library records never enter this directory. */
export class DerivedCache {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly maxBytes: number) {}
  async get<T>(key: readonly unknown[], parse: (raw: unknown) => T): Promise<T | undefined> {
    const descriptor = JSON.stringify(key), path = this.path(descriptor);
    try {
      if ((await stat(path)).size > 8_000_000) return;
      const raw = JSON.parse(await readFile(path, 'utf8'));
      if (raw.version !== 2 || raw.key !== descriptor) return;
      const value = parse(raw.value);
      const now = new Date(); await utimes(path, now, now).catch(() => undefined);
      return value;
    } catch { return undefined; }
  }
  put(key: readonly unknown[], value: unknown): Promise<void> {
    const descriptor = JSON.stringify(key), path = this.path(descriptor);
    const contents = JSON.stringify({ version: 2, key: descriptor, value });
    if (Buffer.byteLength(contents) > 8_000_000) return Promise.reject(new Error('Derived cache entry exceeds its size limit'));
    const operation = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await atomicWrite(path, contents);
      const entries = await readdir(this.directory, { withFileTypes: true });
      const files = await Promise.all(entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).map(async entry => {
        const file = join(this.directory, entry.name), info = await stat(file);
        return { file, size: info.size, used: info.mtimeMs };
      }));
      let bytes = files.reduce((total, file) => total + file.size, 0);
      for (const file of files.sort((a, b) => a.used - b.used)) {
        if (bytes <= this.maxBytes) break;
        await rm(file.file, { force: true }); bytes -= file.size;
      }
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  async flush(): Promise<void> { await this.writes; }
  private path(descriptor: string): string { return join(this.directory, `${createHash('sha256').update(descriptor).digest('hex')}.json`); }
}
