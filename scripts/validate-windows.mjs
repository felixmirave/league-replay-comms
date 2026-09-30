import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestFile, verifiedArtifact } from './artifact-evidence.mjs';
import { runValidationSteps, verifyTestResults } from './validation-steps.mjs';

const flags = process.argv.slice(2);
assert(flags.every(flag => flag === '--prepared'), 'Usage: npm run validate:windows -- [--prepared]');
assert.equal(process.platform, 'win32', 'Windows validation must run on Windows; Linux checks cannot satisfy it');
assert.equal(process.arch, 'x64', 'Use an x64 Node installation for this Windows x64 build');
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 22 || (major === 22 && minor >= 18), 'Node 22.18 or later is required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
await access(npmCli).catch(() => { throw new Error('Cannot locate npm. Run this through npm run validate:windows.'); });
assert(process.env.SystemRoot, 'Windows SystemRoot is unavailable');
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
await access(powershell);
const host = JSON.parse((await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
  '$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object Security.Principal.WindowsPrincipal($identity); [pscustomobject]@{ interactive=[Environment]::UserInteractive; sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId; elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); windows=[Environment]::OSVersion.VersionString; powershell=$PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 })).stdout);
assert(host.interactive === true && host.sessionId > 0, 'Use an active Windows desktop session; a service/session-0 runner cannot validate the GUI');
assert.equal(host.elevated, false, 'Run validation as a standard user, not an elevated administrator');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const executable = join(root, `release/LeagueReplayComms-${version}-x64.exe`);
const reportsRoot = join(root, 'release/validation');
await mkdir(reportsRoot, { recursive: true });
const directory = await mkdtemp(join(reportsRoot, 'windows-'));
const env = { ...process.env, COMMS_TEST_MPV: join(root, 'resources/bin/win32-x64/mpv.exe'), COMMS_TEST_FFMPEG: join(root, 'resources/bin/win32-x64/ffmpeg.exe'), COMMS_TEST_FFPROBE: join(root, 'resources/bin/win32-x64/ffprobe.exe'), COMMS_TEST_POWERSHELL: powershell };
delete env.COMMS_TEST_NO_SANDBOX;
delete env.ELECTRON_RUN_AS_NODE;
const npm = (name, ...args) => ({ name, executable: process.execPath, args: [npmCli, ...args] });
const node = (name, ...args) => ({ name, executable: process.execPath, args });
const nativeFiles = (await readdir(join(root, 'tests/integration'))).filter(name => name.endsWith('.test.ts')).map(name => `tests/integration/${name}`);
const packagingTests = (await readdir(join(root, 'scripts'))).filter(name => name.endsWith('.test.mjs')).map(name => `scripts/${name}`);
const testReport = join(directory, 'tests.json'), junitReport = join(directory, 'tests.xml');
const portableDirectory = join(directory, 'portable');
const steps = [
  ...(!flags.includes('--prepared') ? [npm('install', 'ci'), npm('electron', 'run', 'setup:electron'), npm('native-resources', 'run', 'prepare:native'), npm('ocr-resources', 'run', 'prepare:ocr'), npm('notices', 'run', 'prepare:notices')] : []),
  node('verify-resources', 'scripts/verify-resources.mjs'),
  node('types', 'node_modules/typescript/bin/tsc', '--noEmit'),
  { ...node('tests', 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--reporter=default', '--reporter=json', '--reporter=junit', `--outputFile.json=${testReport}`, `--outputFile.junit=${junitReport}`), verify: () => verifyTestResults(testReport, nativeFiles) },
  node('packaging-tests', '--test', ...packagingTests),
  node('build', 'scripts/build.mjs'),
  node('source-smoke', 'scripts/smoke-ui.mjs'),
  node('volume-controls', '--test', 'scripts/test-volume-ui.mjs'),
  node('debugger-driver', 'scripts/smoke-driver.mjs'),
  node('source-review', 'scripts/test-review-ui.mjs'),
  node('package', 'scripts/package-win.mjs'),
  { ...node('payload', 'scripts/verify-artifact.mjs'), verify: async () => { const record = await verifiedArtifact(executable); return { sha256: record.sha256, bytes: record.bytes, files: Object.keys(record.payloadFiles).length }; } },
  { ...node('portable', 'scripts/test-portable.mjs', executable, portableDirectory), verify: async () => {
    const record = await verifiedArtifact(executable), result = JSON.parse(await readFile(join(portableDirectory, 'portable-execution.json'), 'utf8'));
    assert.equal(result.status, 'passed', 'Portable workflow did not pass');
    assert.equal(result.platform, 'win32'); assert.equal(result.sha256, record.sha256, 'Portable evidence belongs to another artifact');
    assert.equal(result.claims.automatedPortableExecution, true, 'Portable execution was not verified');
    return { sha256: record.sha256, checks: result.checks, claims: result.claims };
  } },
];
const abort = new AbortController();
const cancel = () => abort.abort(new Error('Windows validation cancelled'));
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
console.log(`Windows validation evidence: ${directory}`);
try {
  const report = await runValidationSteps(steps, { cwd: root, env, directory, signal: abort.signal, evidence: {
    host, node: process.versions.node, preparedResourcesReused: flags.includes('--prepared'), packageLockSha256: await digestFile(join(root, 'package-lock.json')),
    commitReportedByCi: process.env.CI_COMMIT_SHA, cleanWindowsVerified: false, networkIsolationVerified: false, leagueIntegrationVerified: false, audibleAccuracyVerified: false,
  } });
  const payload = report.steps.find(step => step.name === 'payload').result;
  await writeFile(join(directory, 'artifact.json'), JSON.stringify({ artifact: executable, ...payload, validation: 'validation.json', portableExecution: 'portable/portable-execution.json' }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Windows automated validation passed for ${payload.sha256}. Complete the separate clean-account, current-League, and physical timing procedure in tests/acceptance/WINDOWS.md.`);
} finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
