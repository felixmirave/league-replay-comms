import { resolve } from 'node:path';
import { sameFileVersion, type FileVersion } from '../library/model';

export interface MediaReference { hash?: string; importId?: string; path: string; version: FileVersion }

export function sameMedia(a: MediaReference, b: MediaReference): boolean {
  if (a.hash && b.hash) return a.hash === b.hash;
  return a === b || !!(a.importId && a.importId === b.importId) || (resolve(a.path) === resolve(b.path) && sameFileVersion(a.version, b.version));
}
