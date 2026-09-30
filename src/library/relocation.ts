import { opendir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileVersion } from './identity';
import { sameFileVersion, type FileIdentity, type LibraryData } from './model';

type StoredFile = LibraryData['media'][string];
type Identifier = (path: string, signal?: AbortSignal) => Promise<FileIdentity>;

/** Search only known/configured locations. A candidate's size never proves identity. */
export async function relocateFile(file: StoredFile, folders: string[], identify: Identifier, signal?: AbortSignal, maxEntries = 10_000): Promise<FileIdentity | undefined> {
  const tested = new Set<string>();
  for (const location of file.locations) {
    signal?.throwIfAborted();
    tested.add(resolve(location.path));
    try {
      const version = await fileVersion(location.path);
      if (sameFileVersion(version, location.version)) return { ...location, sha256: file.hash };
      if (version.size === file.size) {
        const found = await identify(location.path, signal);
        if (found.sha256 === file.hash) return found;
      }
    } catch { signal?.throwIfAborted(); }
  }
  const directories = [
    ...file.locations.map(location => ({ path: dirname(location.path), depth: 0 })),
    ...folders.map(path => ({ path, depth: 4 })),
  ];
  const visited = new Map<string, number>();
  let examined = 0;
  while (directories.length && examined < maxEntries) {
    signal?.throwIfAborted();
    const directory = directories.shift()!;
    const path = resolve(directory.path);
    if ((visited.get(path) ?? -1) >= directory.depth) continue;
    visited.set(path, directory.depth);
    try {
      for await (const entry of await opendir(path)) {
        signal?.throwIfAborted();
        if (++examined > maxEntries) break;
        const candidate = join(path, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && directory.depth > 0) { directories.push({ path: candidate, depth: directory.depth - 1 }); continue; }
        if (!entry.isFile() || tested.has(candidate)) continue;
        tested.add(candidate);
        try {
          if ((await fileVersion(candidate)).size !== file.size) continue;
          const found = await identify(candidate, signal);
          if (found.sha256 === file.hash) return found;
        } catch { signal?.throwIfAborted(); }
      }
    } catch { signal?.throwIfAborted(); }
  }
  return undefined;
}
