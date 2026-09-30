import { opendir } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { configBackupSchema, configDigest } from './config-edit';
import { readConfigBytes } from './config-files';
import { enableReplayConfig } from './config';
import type { ConfigBackupView } from '../shared/setup';

export async function configBackups(root: string, path: string, currentDigest?: string): Promise<ConfigBackupView[]> {
  const found: ConfigBackupView[] = [];
  try {
    const entries = await opendir(dirname(path));
    let visited = 0;
    for await (const entry of entries) {
      if (++visited > 4000 || found.length >= 64) break;
      if (!entry.isFile() || !entry.name.startsWith(`${basename(path)}.comms-`) || !entry.name.endsWith('.json')) continue;
      try {
        const receipt = configBackupSchema.parse(JSON.parse((await readConfigBytes(join(dirname(path), entry.name), 128 * 1024)).toString('utf8')));
        if (receipt.action !== 'enable' || entry.name !== `${basename(path)}.comms-${receipt.id}.json` || receipt.root !== root || receipt.relative !== relative(root, path).split(sep).join('/')) continue;
        const backupPath = `${path}.comms-${receipt.id}.bak`;
        const bytes = await readConfigBytes(backupPath);
        if (configDigest(bytes) !== receipt.beforeSha256 || configDigest(enableReplayConfig(bytes)) !== receipt.afterSha256) continue;
        found.push({ id: receipt.id, path: backupPath, createdAt: receipt.createdAt, canRestore: currentDigest === receipt.afterSha256,
          reason: currentDigest === receipt.afterSha256 ? undefined : 'Configuration changed after this edit. Use the backup for manual recovery; automatic restore will not overwrite later changes.' });
      } catch { /* Untrusted or damaged receipts cannot authorize restoration. */ }
    }
  } catch { /* A missing/unreadable backup directory does not prevent inspection. */ }
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
}
