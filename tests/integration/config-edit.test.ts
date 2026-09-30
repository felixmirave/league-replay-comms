import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm, link, rename, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WindowsConfigEdits, configDigest, editRequest, type ConfigEditRequest } from '../../src/platform/config-edit';
import { enableReplayConfig } from '../../src/platform/config';
import { inspectLeagueInstallation } from '../../src/platform/installation';

const executable = process.env.COMMS_TEST_POWERSHELL;
const available = process.platform === 'win32' || !!executable;
let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'config-helper-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
async function fixture(bytes: Buffer) {
  const root = join(folder, 'League café & comms'), config = join(root, 'Config', 'game.cfg');
  await mkdir(join(root, 'Config'), { recursive: true }); await writeFile(join(root, 'LeagueClient.exe'), 'MZ test marker, never executed');
  await writeFile(config, bytes);
  return { root, config, helper: new WindowsConfigEdits(resolve('resources/scripts'), join(folder, 'requests'), executable) };
}
const utf8 = (text: string) => Buffer.from(text, 'utf8');
const cases = [
  utf8('[General]\r\nEnableReplayApi = 0 ; keep comment\r\nOther=café\r\n'),
  utf8('[Other]\nEnableReplayApi=0\n'),
  utf8('[General]\nOther=1'),
  utf8('[General]\nEnableReplayApi=\u00a00\u00a0; preserve spaces\n[Other]\nUnrelated=true\n'),
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('[General]\rEnableReplayApi=0\r')]),
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[General]\r\nOther=聲音\r\nEnableReplayApi=0\r\n', 'utf16le')]),
];
describe.skipIf(!available)('real scoped configuration helper', () => {
  it('compiles the Windows handle guard and preserves the native information-structure layout', async () => {
    const script = await readFile('resources/scripts/edit-replay-config.ps1', 'utf8');
    const source = script.match(/Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/)?.[1];
    expect(source).toBeTruthy();
    const path = join(folder, 'guard.cs'); await writeFile(path, source!);
    const shell = executable ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -Path $env:COMMS_GUARD_CS; $t = [ReplayComms.ConfigHandle].GetNestedType('Info', [Reflection.BindingFlags]::NonPublic); [Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($t))"], { env: { ...process.env, COMMS_GUARD_CS: path }, windowsHide: true, timeout: 20000 });
    expect(stdout.trim()).toBe('52');
  }, 30000); // Cold compiler startup is separate from replay timing requirements.
  it.each(cases.map((bytes, index) => ({ bytes, index })))('matches the TypeScript byte edit and restores an unchanged config (case $index)', async ({ bytes }) => {
    const { root, config, helper } = await fixture(bytes);
    const result = await helper.run(editRequest(root, config, configDigest(bytes), 'enable'));
    expect(await readFile(config)).toEqual(enableReplayConfig(bytes));
    expect(result.changed).toBe(true);
    expect(await readFile(result.backup!.path)).toEqual(bytes);
    const report = await inspectLeagueInstallation(root);
    expect(report.configs[0]?.inspection.state).toBe('enabled');
    expect(report.configs[0]?.backups?.[0]?.canRestore).toBe(true);
    await helper.run(editRequest(root, config, result.afterSha256, 'restore', result.backup!.id));
    expect(await readFile(config)).toEqual(bytes);
    expect((await inspectLeagueInstallation(root)).configs[0]?.backups?.[0]?.canRestore).toBe(false);
    await rm(config);
    const missing = (await inspectLeagueInstallation(root)).configs[0]!;
    expect(missing.inspection.state).toBe('missing');
    expect(missing.backups?.[0]?.canRestore).toBe(false);
    expect(missing.backups?.[0]?.path).toBe(result.backup!.path);
  });
  it('leaves an enabled configuration alone without creating a backup', async () => {
    const bytes = utf8('[General]\nEnableReplayApi=1\n'), { root, config, helper } = await fixture(bytes);
    expect((await helper.run(editRequest(root, config, configDigest(bytes), 'enable'))).changed).toBe(false);
    expect(await readdir(join(root, 'Config'))).toEqual(['game.cfg']);
  });
  it('rejects stale inspection and refuses restoring over later edits even with a fresh digest', async () => {
    const bytes = utf8('[General]\nEnableReplayApi=0\n'), { root, config, helper } = await fixture(bytes);
    const later = Buffer.concat([bytes, utf8('Other=changed\n')]);
    await writeFile(config, later);
    await expect(helper.run(editRequest(root, config, configDigest(bytes), 'enable'))).rejects.toMatchObject({ code: 'changed' });
    expect(await readFile(config)).toEqual(later);
    const edited = await helper.run(editRequest(root, config, configDigest(later), 'enable'));
    const after = Buffer.concat([await readFile(config), utf8('Another=new\n')]); await writeFile(config, after);
    await expect(helper.run(editRequest(root, config, configDigest(after), 'restore', edited.backup!.id))).rejects.toMatchObject({ code: 'changed' });
    expect(await readFile(config)).toEqual(after);
    expect((await inspectLeagueInstallation(root)).configs[0]?.backups?.[0]?.canRestore).toBe(false);
  });
  it('rejects damaged backups and requests outside the fixed config locations', async () => {
    const bytes = utf8('[General]\nEnableReplayApi=0\n'), { root, config, helper } = await fixture(bytes);
    const edited = await helper.run(editRequest(root, config, configDigest(bytes), 'enable'));
    await writeFile(edited.backup!.path, 'modified backup');
    await expect(helper.run(editRequest(root, config, edited.afterSha256, 'restore', edited.backup!.id))).rejects.toMatchObject({ code: 'changed' });
    expect((await inspectLeagueInstallation(root)).configs[0]?.backups).toEqual([]);
    const invalid = { ...editRequest(root, config, edited.afterSha256, 'enable'), relative: '../outside.cfg' } as unknown as ConfigEditRequest;
    await expect(helper.run(invalid)).rejects.toMatchObject({ code: 'invalid' });
    expect(await readFile(config)).toEqual(enableReplayConfig(bytes));
  });
  it('refuses read-only, missing, and ambiguous files without replacing configuration', async () => {
    const bytes = utf8('[General]\nEnableReplayApi=0\nEnableReplayApi=1\n'), { root, config, helper } = await fixture(bytes);
    await expect(helper.run(editRequest(root, config, configDigest(bytes), 'enable'))).rejects.toMatchObject({ code: 'invalid' });
    expect(await readFile(config)).toEqual(bytes);
    await chmod(config, 0o444);
    try { await expect(helper.run(editRequest(root, config, configDigest(bytes), 'enable'))).rejects.toMatchObject({ code: 'read-only' }); }
    finally { await chmod(config, 0o644); }
    await rm(config);
    await expect(helper.run(editRequest(root, config, configDigest(bytes), 'enable'))).rejects.toMatchObject({ code: 'missing' });
    await expect(readFile(config)).rejects.toThrow();
  });
  it('refuses an incompatible open handle in another process', async () => {
    const bytes = utf8('[General]\nEnableReplayApi=0\n'), { root, config, helper } = await fixture(bytes);
    const shell = executable ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    // PowerShell forwards termination to its process group on Unix. Isolate the
    // deliberately killed lock holder so cleanup cannot terminate the test runner.
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', "$f = [IO.File]::Open($env:COMMS_LOCK_CONFIG, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::WriteLine('READY'); Start-Sleep -Seconds 30; $f.Dispose()"], { env: { ...process.env, COMMS_LOCK_CONFIG: config }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.on('data', bytes => { if (bytes.toString().includes('READY')) resolve(); }); child.once('error', reject); child.once('exit', code => reject(new Error(`Lock holder exited (${code})`))); });
      await expect(helper.run(editRequest(root, config, configDigest(bytes), 'enable'))).rejects.toMatchObject({ code: 'busy' });
    } finally { const stopped = new Promise<void>(resolve => { child.once('exit', () => resolve()); }); child.kill(); await stopped; }
    expect(await readFile(config)).toEqual(bytes);
  });
  it.skipIf(process.platform !== 'win32')('refuses Windows hard links and junctions before editing', async () => {
    const bytes = utf8('[General]\nEnableReplayApi=0\n'), { root, config, helper } = await fixture(bytes);
    const alias = join(root, 'alias.cfg'); await link(config, alias);
    await expect(helper.run(editRequest(root, config, configDigest(bytes), 'enable'))).rejects.toMatchObject({ code: 'invalid' });
    await rm(alias);
    await rename(join(root, 'Config'), join(root, 'ActualConfig'));
    await symlink(join(root, 'ActualConfig'), join(root, 'Config'), 'junction');
    await expect(helper.run(editRequest(root, config, configDigest(bytes), 'enable'))).rejects.toMatchObject({ code: 'invalid' });
    expect(await readFile(config)).toEqual(bytes);
  });
});
