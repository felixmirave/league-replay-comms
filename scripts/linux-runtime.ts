import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const runtimeCache = join(projectRoot, '.cache/linux');
export interface Archive { name: string; url: string; sha256: string }
export interface RuntimeLock { schemaVersion: 1; platform: 'debian-13-amd64'; node: Archive; packages: Archive[] }
function archive(value: unknown): Archive {
  const item = value as Partial<Archive> | null;
  if (!item || typeof item.name !== 'string' || !/^[a-zA-Z0-9_%+~.-]+$/.test(item.name) || item.name.startsWith('.') ||
      typeof item.url !== 'string' || !item.url.startsWith('https://') || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    throw new Error('Invalid pinned Linux archive');
  }
  return item as Archive;
}
export async function readRuntimeLock(): Promise<RuntimeLock> {
  const value = JSON.parse(await readFile(join(projectRoot, 'scripts/linux-runtime-lock.json'), 'utf8'));
  if (value.schemaVersion !== 1 || value.platform !== 'debian-13-amd64' || !Array.isArray(value.packages)) throw new Error('Unsupported Linux runtime lock');
  const node = archive(value.node), packages = value.packages.map(archive);
  if (!/^node-v\d+\.\d+\.\d+-linux-x64\.tar\.xz$/.test(node.name) || packages.some((item: Archive) => !item.name.endsWith('.deb'))) throw new Error('Unexpected Linux archive type');
  if (new Set([node, ...packages].map(item => item.name)).size !== packages.length + 1) throw new Error('Duplicate Linux archive names');
  return { schemaVersion: 1, platform: 'debian-13-amd64', node, packages };
}
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function downloadArchive(item: Archive, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const destination = join(directory, item.name);
  try { if (await sha256File(destination) === item.sha256) return destination; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const partial = destination + '.partial';
  try {
    const signal = AbortSignal.timeout(90000);
    const response = await fetch(item.url, { signal });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${item.name}`);
    await pipeline(Readable.from(response.body), createWriteStream(partial), { signal });
    if (await sha256File(partial) !== item.sha256) throw new Error('Checksum mismatch: ' + item.name);
    await rename(partial, destination);
    return destination;
  } finally { await rm(partial, { force: true }); }
}
export async function downloadArchives(items: Archive[], directory: string): Promise<string[]> {
  const paths: string[] = new Array(items.length);
  let next = 0, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (next < items.length && !failure) {
      const index = next++;
      try { paths[index] = await downloadArchive(items[index]!, directory); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return paths;
}
export const environmentKeys = ['PATH', 'LD_LIBRARY_PATH', 'FONTCONFIG_FILE', 'COMMS_DEV_PULSE_MODULES', 'COMMS_TEST_MPV', 'COMMS_TEST_FFMPEG', 'COMMS_TEST_FFPROBE'] as const;
export async function runtimeEnvironment(): Promise<NodeJS.ProcessEnv> {
  let data: unknown;
  try { data = JSON.parse(await readFile(join(runtimeCache, 'environment.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Run sh scripts/linux.sh --prepare first');
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Linux runtime environment');
  const value = data as Record<string, unknown>, env = { ...process.env };
  for (const key of environmentKeys) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error('Invalid Linux runtime environment: ' + key);
    env[key] = value[key];
  }
  return env;
}
