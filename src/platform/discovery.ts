import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { z } from 'zod';

const reportSchema = z.object({
  roots: z.array(z.string().max(32768)).max(128),
  processes: z.array(z.object({ name: z.string().max(100), path: z.string().max(32768).nullable() })).max(128),
  warnings: z.array(z.string().max(500)).max(32),
});
export interface InstallationDiscovery { roots: string[]; warnings: string[] }
export interface LeagueDiscovery { discover(signal?: AbortSignal): Promise<InstallationDiscovery> }

/** Normalize Windows paths without executing, expanding, or searching their contents. */
export function decodeInstallationDiscovery(output: string): InstallationDiscovery {
  const report = reportSchema.parse(JSON.parse(output.replace(/^\uFEFF/, '')));
  const roots = [...report.roots];
  for (const process of report.processes) {
    if (!process.path) continue;
    const name = process.name.toLowerCase();
    if (name !== win32.basename(process.path).toLowerCase()) continue;
    if (name === 'leagueclient.exe') roots.push(win32.dirname(process.path));
    else if (name === 'league of legends.exe') {
      const directory = win32.dirname(process.path);
      roots.push(win32.basename(directory).toLowerCase() === 'game' ? win32.dirname(directory) : directory);
    }
  }
  const unique = new Map<string, string>();
  for (const root of roots) {
    // Discovery must not trigger reads of arbitrary network shares or device paths.
    if (!/^[a-z]:[\\/]/i.test(root) || /[\x00-\x1f]/.test(root)) continue;
    const normalized = win32.normalize(root).replace(/[\\/]$/, '');
    if (normalized.length <= 3) continue;
    unique.set(normalized.toLowerCase(), normalized);
  }
  return { roots: [...unique.values()].slice(0, 32), warnings: report.warnings };
}

export class WindowsLeagueDiscovery implements LeagueDiscovery {
  constructor(private readonly scriptPath: string) {}
  async discover(signal?: AbortSignal): Promise<InstallationDiscovery> {
    if (process.platform !== 'win32') return { roots: [], warnings: ['Automatic installation detection is available on Windows. You can select a League folder manually.'] };
    const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = await new Promise<string>((resolve, reject) => {
      execFile(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024, signal },
        (error, stdout) => { if (error) reject(new Error('Windows installation detection failed. Select the League folder manually.', { cause: error })); else resolve(stdout); });
    });
    return decodeInstallationDiscovery(output);
  }
}
