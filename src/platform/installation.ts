import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectReplayConfig } from './config';
import type { LeagueInstallation, ReplayConfigView } from '../shared/setup';
import { readConfigBytes } from './config-files';
import { configDigest } from './config-edit';
import { configBackups } from './config-backups';

async function isFile(path: string): Promise<boolean> { try { return (await stat(path)).isFile(); } catch { return false; } }
async function inspectFile(root: string, path: string): Promise<ReplayConfigView | undefined> {
  try {
    const bytes = await readConfigBytes(path), sha256 = configDigest(bytes);
    return { path, sha256, inspection: inspectReplayConfig(bytes), backups: await configBackups(root, path, sha256) };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    const backups = await configBackups(root, path);
    if (missing && !backups.length) return;
    return { path, backups, inspection: { state: missing ? 'missing' : 'unreadable', reason: error instanceof Error ? error.message : String(error) } };
  }
}

/** Validate the installation before considering Riot's known configuration candidates. */
export async function inspectLeagueInstallation(folder: string): Promise<LeagueInstallation> {
  const root = await realpath(resolve(folder));
  const markers = [join(root, 'LeagueClient.exe'), join(root, 'Game', 'League of Legends.exe'), join(root, 'League of Legends.exe')];
  if (!(await Promise.all(markers.map(isFile))).some(Boolean)) throw new Error('Choose the League of Legends installation folder containing LeagueClient.exe or the Game folder.');
  const candidates = [join(root, 'Config', 'game.cfg'), join(root, 'Game', 'Config', 'game.cfg'), join(root, 'DATA', 'CFG', 'game.cfg')];
  const configs = (await Promise.all(candidates.map(path => inspectFile(root, path)))).filter((value): value is ReplayConfigView => !!value);
  return { root, configs: configs.length ? configs : [{ path: candidates[0]!, inspection: { state: 'missing', reason: 'No game.cfg was found in this installation. Run League once, then refresh. The application will not create a replacement game configuration.' } }] };
}
