import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep, win32 } from 'node:path';
import { z } from 'zod';
import { readConfigBytes } from './config-files';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const configRelativeSchema = z.enum(['Config/game.cfg', 'Game/Config/game.cfg', 'DATA/CFG/game.cfg']);
export const configBackupSchema = z.object({
  version: z.literal(1), id: z.uuid(), action: z.enum(['enable', 'restore']), root: z.string().max(32768), relative: configRelativeSchema,
  path: z.string().max(32768), beforeSha256: digest, afterSha256: digest, createdAt: z.string().datetime({ offset: true }),
});
export type ConfigBackup = z.infer<typeof configBackupSchema>;
export interface ConfigEditRequest { version: 1; id: string; action: 'enable' | 'restore'; root: string; relative: z.infer<typeof configRelativeSchema>; expectedSha256: string; backupId?: string }
const resultSchema = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), id: z.uuid(), ok: z.literal(true), changed: z.boolean(), beforeSha256: digest, afterSha256: digest, backup: configBackupSchema.optional() }),
  z.object({ version: z.literal(1), id: z.uuid(), ok: z.literal(false), code: z.enum(['invalid', 'changed', 'permission', 'busy', 'read-only', 'missing', 'write-failed', 'recovery-needed']), message: z.string().max(131072), backup: configBackupSchema.nullish() }),
]);
export type ConfigEditResult = Extract<z.infer<typeof resultSchema>, { ok: true }>;
export class ConfigEditError extends Error {
  constructor(readonly code: string, message: string, readonly backup?: ConfigBackup) { super(message); }
}
export interface ConfigEdits { run(request: ConfigEditRequest, elevated?: boolean): Promise<ConfigEditResult> }
export const configDigest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function editRequest(root: string, path: string, sha256: string, action: 'enable' | 'restore', backupId?: string): ConfigEditRequest {
  digest.parse(sha256);
  if (backupId) z.uuid().parse(backupId);
  return { version: 1, id: randomUUID(), root, relative: configRelativeSchema.parse(relative(root, path).split(sep).join('/')), expectedSha256: sha256, action, backupId };
}

/** Launches only the bundled scoped helper; never elevates the reviewing app. */
export class WindowsConfigEdits implements ConfigEdits {
  constructor(private readonly scriptsDirectory: string, private readonly requestsDirectory: string, private readonly testExecutable?: string) {}
  async run(request: ConfigEditRequest, elevated = false): Promise<ConfigEditResult> {
    if (process.platform !== 'win32' && !this.testExecutable) throw new ConfigEditError('unsupported', 'Automatic configuration editing is supported on Windows. Use the displayed manual instructions.');
    if (elevated && process.platform !== 'win32') throw new ConfigEditError('unsupported', 'Windows elevation cannot run on this platform.');
    await mkdir(this.requestsDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.requestsDirectory, 'config-'));
    const path = join(directory, 'request.json');
    try {
      const requestBytes = Buffer.from(JSON.stringify(request));
      await writeFile(path, requestBytes, { flag: 'wx', mode: 0o600 });
      const executable = this.testExecutable ?? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = join(this.scriptsDirectory, elevated ? 'elevate-replay-config.ps1' : 'edit-replay-config.ps1');
      await new Promise<void>((resolve, reject) => {
        // Do not kill a helper midway through an exclusive write. UAC can remain
        // pending until the user accepts or declines; normal close drains this job.
        execFile(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-RequestPath', path, '-RequestSha256', configDigest(requestBytes)],
          { windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 }, error => {
            if (!error) resolve();
            else if (Number(error.code) === 1223) reject(new ConfigEditError('elevation-declined', 'Windows permission was declined. The manual config instructions remain available.'));
            else reject(new ConfigEditError('helper-failed', 'The configuration helper did not finish successfully. Refresh setup and check available backups before retrying.'));
          });
      });
      const result = resultSchema.parse(JSON.parse((await readConfigBytes(`${path}.result.json`, 256 * 1024)).toString('utf8')));
      if (result.id !== request.id) throw new ConfigEditError('invalid', 'Configuration helper returned a different operation ID.');
      if (!result.ok) throw new ConfigEditError(result.code, result.message, result.backup ?? undefined);
      if (result.beforeSha256 !== request.expectedSha256) throw new ConfigEditError('invalid', 'Configuration helper returned a different source digest.');
      if (result.backup && (result.backup.root !== request.root || result.backup.relative !== request.relative || result.backup.action !== request.action || result.backup.path !== `${join(request.root, request.relative)}.comms-${result.backup.id}.bak` || result.backup.beforeSha256 !== result.beforeSha256 || result.backup.afterSha256 !== result.afterSha256)) throw new ConfigEditError('invalid', 'Configuration helper returned an inconsistent backup record. Refresh setup to inspect the saved files.');
      return result;
    } catch (error) {
      if (error instanceof ConfigEditError) throw error;
      throw new ConfigEditError('helper-failed', 'The configuration helper result could not be verified. Refresh setup and check available backups before retrying.');
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }
}
