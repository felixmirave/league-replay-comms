import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferenceEdits } from '../src/main/preference-edits';
import { decodeInstallationDiscovery } from '../src/platform/discovery';
import { inspectLeagueInstallation } from '../src/platform/installation';
import { LeagueSetup } from '../src/main/league-setup';
import { ReviewLibrary } from '../src/library/library';
import { ConfigEditError, configDigest, type ConfigEdits, type ConfigEditRequest, type ConfigEditResult } from '../src/platform/config-edit';
import { enableReplayConfig } from '../src/platform/config';

let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'league-setup-')); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
async function installation(name = 'League café', contents?: string): Promise<string> {
  const root = join(folder, name);
  await mkdir(root); await writeFile(join(root, 'LeagueClient.exe'), 'MZ synthetic installation marker');
  if (contents !== undefined) { await mkdir(join(root, 'Config')); await writeFile(join(root, 'Config', 'game.cfg'), contents); }
  return root;
}

describe('League installation inspection', () => {
  it('normalizes registry and running-process roots without accepting remote/device paths or unrelated executables', () => {
    const result = decodeInstallationDiscovery(JSON.stringify({ roots: ['D:\\Games\\League café\\', 'd:\\games\\league café', '\\\\server\\share', '\\\\?\\C:\\Device', 'C:relative', 'C:\\'],
      processes: [{ name: 'League of Legends.exe', path: 'E:\\Riot\\League\\Game\\League of Legends.exe' }, { name: 'LeagueClient.exe', path: 'C:\\Riot Games\\League\\LeagueClient.exe' }, { name: 'LeagueClient.exe', path: 'C:\\Something\\Other.exe' }, { name: 'Other.exe', path: 'C:\\Something\\Other.exe' }, { name: 'LeagueClient.exe', path: null }], warnings: [] }));
    expect(result.roots).toEqual(['d:\\games\\league café', 'E:\\Riot\\League', 'C:\\Riot Games\\League']);
    expect(() => decodeInstallationDiscovery('{"roots":"C:\\\\League"}')).toThrow();
  });
  it('distinguishes enabled, disabled, missing, and ambiguous configuration without changing any bytes', async () => {
    const root = await installation('League', '[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
    const path = join(root, 'Config', 'game.cfg');
    expect((await inspectLeagueInstallation(root)).configs[0]?.inspection).toEqual({ state: 'disabled', missing: false });
    expect(await readFile(path, 'utf8')).toBe('[General]\r\nEnableReplayApi=0\r\nOther=keep\r\n');
    await writeFile(path, '[General]\nEnableReplayApi=1\n');
    expect((await inspectLeagueInstallation(root)).configs[0]?.inspection.state).toBe('enabled');
    await writeFile(path, '[General]\nEnableReplayApi=1\nEnableReplayApi=0\n');
    expect((await inspectLeagueInstallation(root)).configs[0]?.inspection.state).toBe('ambiguous');
    await rm(path);
    expect((await inspectLeagueInstallation(root)).configs[0]?.inspection.state).toBe('missing');
    await expect(readFile(path)).rejects.toThrow();
  });
  it('reports all known config locations and does not guess when they disagree', async () => {
    const root = await installation('League', '[General]\nEnableReplayApi=1\n');
    await mkdir(join(root, 'Game', 'Config'), { recursive: true }); await writeFile(join(root, 'Game', 'Config', 'game.cfg'), '[General]\nEnableReplayApi=0');
    await mkdir(join(root, 'DATA', 'CFG'), { recursive: true }); await writeFile(join(root, 'DATA', 'CFG', 'game.cfg'), '[General]');
    const report = await inspectLeagueInstallation(root);
    expect(report.configs.map(config => config.inspection.state)).toEqual(['enabled', 'disabled', 'disabled']);
  });
  it('rejects unrelated folders and bounds oversized/malformed config reads', async () => {
    await expect(inspectLeagueInstallation(folder)).rejects.toThrow('installation folder');
    const root = await installation('League', '');
    await writeFile(join(root, 'Config', 'game.cfg'), Buffer.alloc(1024 * 1024 + 1));
    expect((await inspectLeagueInstallation(root)).configs[0]?.inspection.state).toBe('unreadable');
    await writeFile(join(root, 'Config', 'game.cfg'), Buffer.from([0xff, 0xfe, 0x00]));
    expect((await inspectLeagueInstallation(root)).configs[0]?.inspection.state).toBe('ambiguous');
    await rm(join(root, 'Config', 'game.cfg')); await mkdir(join(root, 'Config', 'game.cfg'));
    expect((await inspectLeagueInstallation(root)).configs[0]?.inspection.state).toBe('unreadable');
  });
});

describe('setup workflow', () => {
  it('retains a failed installation preference through refresh and shared save retry', async () => {
    const root = await installation('League', '[General]');
    const library = await ReviewLibrary.open(join(folder, 'data')), preferences = new PreferenceEdits(library);
    const setup = new LeagueSetup({ discover: async () => ({ roots: [], warnings: [] }) }, library, () => {}, undefined, undefined, preferences);
    const fail = vi.spyOn(library, 'updateSettings').mockRejectedValue(new Error('Disk unavailable'));
    await expect(setup.select(root)).rejects.toThrow('Disk unavailable');
    await setup.refresh();
    expect(setup.snapshot().selectedRoot).toBe(root);
    expect(preferences.message()).toContain('League installation');
    fail.mockRestore(); await preferences.retry();
    expect(preferences.message()).toBeUndefined();
    expect((await ReviewLibrary.open(join(folder, 'data'))).snapshot().settings.selectedInstallation).toBe(root);
  });

  it('offers elevation only after a permission failure and keeps its original target and digest', async () => {
    const root = await installation('League', '[General]\nEnableReplayApi=0');
    const library = await ReviewLibrary.open(join(folder, 'data'));
    const calls: { request: ConfigEditRequest; elevated: boolean }[] = [];
    const edits: ConfigEdits = { run: async (request, elevated = false) => {
      calls.push({ request, elevated });
      if (!elevated) throw new ConfigEditError('permission', 'Windows permission needed');
      const path = join(root, 'Config', 'game.cfg');
      const after = enableReplayConfig(await readFile(path)); await writeFile(path, after);
      return { version: 1, id: request.id, ok: true, changed: true, beforeSha256: request.expectedSha256, afterSha256: configDigest(after) };
    } };
    const setup = new LeagueSetup({ discover: async () => ({ roots: [], warnings: [] }) }, library, () => {}, undefined, edits);
    await setup.select(root);
    await expect(setup.approveElevation()).rejects.toThrow('first');
    await expect(setup.enable(join(root, 'Config', 'game.cfg'))).rejects.toMatchObject({ code: 'permission' });
    expect(setup.snapshot().needsElevation?.action).toBe('enable');
    await setup.approveElevation();
    expect(calls.map(call => call.elevated)).toEqual([false, true]);
    expect(calls[1]?.request).toEqual(calls[0]?.request);
    expect(setup.snapshot().needsElevation).toBeUndefined();
    expect(setup.snapshot().installations[0]?.configs[0]?.inspection.state).toBe('enabled');
    expect(setup.snapshot().message).toContain('Restart the replay');
  });
  it('does not elevate after other errors or retain permission to edit a different selection', async () => {
    const root = await installation('League', '[General]\nEnableReplayApi=0'), other = await installation('Other', '[General]');
    const library = await ReviewLibrary.open(join(folder, 'data'));
    let code = 'changed';
    const setup = new LeagueSetup({ discover: async () => ({ roots: [], warnings: [] }) }, library, () => {}, undefined, { run: async () => { throw new ConfigEditError(code, code); } });
    await setup.select(root);
    await expect(setup.enable(join(root, 'Config', 'game.cfg'))).rejects.toMatchObject({ code: 'changed' });
    expect(setup.snapshot().needsElevation).toBeUndefined();
    code = 'permission';
    await expect(setup.enable(join(root, 'Config', 'game.cfg'))).rejects.toMatchObject({ code: 'permission' });
    await setup.select(other); await expect(setup.approveElevation()).rejects.toThrow('first');
    await expect(setup.enable(join(root, 'Config', 'game.cfg'))).rejects.toThrow('Select an installation');
    await expect(setup.restore(join(other, 'Config', 'game.cfg'), '00000000-0000-4000-8000-000000000000')).rejects.toThrow('backup');
  });
  it('keeps configuration changes serialized and reports changes made immediately after the helper finishes', async () => {
    const root = await installation('League', '[General]\nEnableReplayApi=0');
    const library = await ReviewLibrary.open(join(folder, 'data'));
    let complete!: (value: ConfigEditResult) => void, request!: ConfigEditRequest;
    const pending = new Promise<ConfigEditResult>(resolve => { complete = resolve; });
    const setup = new LeagueSetup({ discover: async () => ({ roots: [], warnings: [] }) }, library, () => {}, undefined, { run: async value => { request = value; return pending; } });
    await setup.select(root);
    const saving = setup.enable(join(root, 'Config', 'game.cfg'));
    expect(setup.snapshot().editing).toBe(true);
    await expect(setup.select(root)).rejects.toThrow('finish');
    await expect(setup.refresh()).rejects.toThrow('finish');
    complete({ version: 1, ok: true, changed: true, id: request.id, beforeSha256: request.expectedSha256, afterSha256: 'f'.repeat(64) });
    await saving;
    expect(setup.snapshot().message).toContain('changed again');
    expect(setup.snapshot().editing).toBe(false);
  });
  it('preserves explicit installation choice across refresh/restart even when discovery fails', async () => {
    const root = await installation('League', '[General]\nEnableReplayApi=1');
    const library = await ReviewLibrary.open(join(folder, 'data'));
    const setup = new LeagueSetup({ discover: async () => { throw new Error('Process inspection unavailable'); } }, library, () => {});
    await setup.select(root);
    const restarted = await ReviewLibrary.open(join(folder, 'data'));
    const next = new LeagueSetup({ discover: async () => { throw new Error('Process inspection unavailable'); } }, restarted, () => {});
    await next.refresh();
    expect(next.snapshot().selectedRoot).toBe(root);
    expect(next.snapshot().installations[0]?.configs[0]?.inspection.state).toBe('enabled');
    expect(next.snapshot().warnings).toContain('Process inspection unavailable');
    // No runtime replay state is fabricated from an enabled config.
    expect(next.snapshot()).not.toHaveProperty('connected');
  });
  it('does not select an arbitrary installation when several are detected', async () => {
    const a = await installation('Live', '[General]'), b = await installation('Other', '[General]');
    const library = await ReviewLibrary.open(join(folder, 'data'));
    const setup = new LeagueSetup({ discover: async () => ({ roots: [a, b, a, join(folder, 'missing')], warnings: [] }) }, library, () => {});
    await setup.refresh();
    expect(setup.snapshot().installations).toHaveLength(2);
    expect(setup.snapshot().selectedRoot).toBeUndefined();
    await setup.select(b); await setup.refresh();
    expect(setup.snapshot().selectedRoot).toBe(b);
  });
  it('ignores a delayed scan after manual folder selection and retains the previous choice on an invalid selection', async () => {
    const a = await installation('Live', '[General]'), b = await installation('Selected', '[General]');
    const library = await ReviewLibrary.open(join(folder, 'data'));
    let complete!: (value: { roots: string[]; warnings: string[] }) => void;
    const pending = new Promise<{ roots: string[]; warnings: string[] }>(resolve => { complete = resolve; });
    const setup = new LeagueSetup({ discover: async () => pending }, library, () => {});
    const scanning = setup.refresh(); await setup.select(b);
    complete({ roots: [a], warnings: [] }); await scanning;
    expect(setup.snapshot().selectedRoot).toBe(b);
    await expect(setup.select(folder)).rejects.toThrow('installation folder');
    expect(setup.snapshot().selectedRoot).toBe(b);
    expect(library.snapshot().settings.selectedInstallation).toBe(b);
  });
});
