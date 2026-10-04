import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { command } from './dev-desktop.ts';
import { verifyConnected } from './connected-verification.ts';

const args = process.argv.slice(2);
function option(name: string) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
for (let i = 0; i < args.length; i += 2) if (!['--recording', '--track', '--at'].includes(args[i]!) || !args[i + 1]) throw new Error('Usage: verify:linux [--recording PATH] [--track AUDIO_ORDINAL] [--at SECONDS]');
const recordingPath = option('--recording');
const recording = recordingPath ? { path: resolve(recordingPath), track: Number(option('--track') ?? 1), at: Number(option('--at') ?? 90) } : undefined;
if (recording && (!Number.isInteger(recording.track) || recording.track < 1 || !Number.isFinite(recording.at) || recording.at < 0)) throw new Error('Invalid recording track or timestamp');
if (!recording && (option('--track') || option('--at'))) throw new Error('--track and --at require --recording');
const folder = resolve('release/validation', 'linux-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(folder, { recursive: true });
const report: { status: string; revision?: string; lockSha256?: string; runtimeLockSha256?: string; versions: Record<string, string>; coverage?: unknown; source?: unknown; build?: Record<string, string>; stages: { name: string; status: string; log: string }[]; connected?: unknown; error?: string; exclusions: string[] } = {
  status: 'running', versions: { chromiumProcessSandbox: process.env.COMMS_TEST_NO_SANDBOX === '1' ? 'disabled explicitly' : 'enabled' }, stages: [], exclusions: ['Windows discovery/UAC/handle semantics and packaging execution', 'Windows audio-driver and physical speaker/headphone timing', 'PowerShell helper integration unless COMMS_TEST_POWERSHELL is configured', ...(recording ? [] : ['User recording not supplied; generated multitrack media only'])],
};
const save = () => writeFile(join(folder, 'validation.json'), JSON.stringify(report, null, 2));
async function stage(name: string, executable: string, arguments_: string[]) {
  console.log('Verification:', name);
  const record = { name, status: 'running', log: join(folder, name + '.log') }; report.stages.push(record); await save();
  const output = createWriteStream(record.log);
  try {
    await new Promise<void>((resolveStage, reject) => {
      const child = spawn(executable, arguments_, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.pipe(output, { end: false }); child.stderr!.pipe(output, { end: false });
      const interrupt = () => child.kill('SIGTERM');
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${name} exceeded its 180 second limit`)); }, 180000);
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      child.once('error', error => { clearTimeout(timeout); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); reject(error); });
      child.once('close', code => {
        clearTimeout(timeout); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
        code === 0 ? resolveStage() : reject(new Error(`${name} exited ${code}; inspect ${record.log}`));
      });
    });
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; throw error; }
  finally { await new Promise<void>(resolveLog => output.end(resolveLog)); await save(); }
}
try {
  if (process.platform !== 'linux') throw new Error('Run this workflow on Linux');
  report.revision = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim();
  report.source = { status: (await command('git', ['status', '--porcelain'])).stdout.trim(), changesSha256: createHash('sha256').update((await command('git', ['diff', 'HEAD'])).stdout).digest('hex') };
  report.lockSha256 = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  report.runtimeLockSha256 = createHash('sha256').update(await readFile('scripts/linux-runtime-lock.json')).digest('hex');
  for (const [name, file, arguments_] of [
    ['node', process.execPath, ['--version']], ['mpv', resolve('resources/bin/linux-x64/mpv'), ['--version']],
    ['ffmpeg', resolve('resources/bin/linux-x64/ffmpeg'), ['-version']], ['ffprobe', resolve('resources/bin/linux-x64/ffprobe'), ['-version']],
    ['pulse', 'pulseaudio', ['--version']], ['capture', 'parec', ['--version']], ['calibration', 'paplay', ['--version']], ['audio-control', 'pactl', ['--version']], ['openssl', 'openssl', ['version']],
  ] as const) report.versions[name] = (await command(file, [...arguments_])).stdout.trim();
  await readFile('resources/ocr/worker.cjs');
  await readFile('resources/notices/THIRD_PARTY_NOTICES.html');
  if (recording) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(recording.path)) hash.update(chunk);
    report.versions.recordingSha256 = hash.digest('hex');
    const probe = JSON.parse((await command(resolve('resources/bin/linux-x64/ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', recording.path])).stdout) as { streams: { codec_type: string }[]; format: { duration: string } };
    if (probe.streams.filter(stream => stream.codec_type === 'audio').length < recording.track || recording.at + 5 >= Number(probe.format.duration)) throw new Error('Recording track or timestamp is outside the available media');
  }
  console.log('Evidence directory:', folder);
  await stage('typecheck', 'npm', ['run', 'typecheck']);
  await stage('verification-tools', 'npm', ['run', 'test:dev-verification']);
  await stage('tests', 'npm', ['test', '--', '--reporter=default', '--reporter=json', '--outputFile=' + join(folder, 'tests.json')]);
  const tests = JSON.parse(await readFile(join(folder, 'tests.json'), 'utf8')) as { numPassedTests: number; numPendingTests: number; testResults: { name: string; assertionResults: { status: string; fullName: string }[] }[] };
  const skipped = tests.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'skipped' || test.status === 'pending').map(test => ({ file: file.name, name: test.fullName })));
  report.coverage = { passed: tests.numPassedTests, pending: tests.numPendingTests, skipped };
  if (skipped.some(test => !test.file.endsWith('/tests/integration/config-edit.test.ts'))) throw new Error('Required Linux tests were skipped; inspect tests.json');
  await save();
  await stage('build', 'npm', ['run', 'build']);
  report.build = {};
  async function hashBuild(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await hashBuild(path);
      else report.build![path] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await hashBuild('dist'); await save();
  for (const name of ['smoke:ui', 'smoke:driver', 'test:startup-ui', 'test:volume-ui', 'test:timing-ui', 'test:review-ui']) await stage(name.replaceAll(':', '-'), 'xvfb-run', ['-a', '-s', '-screen 0 1280x1024x24 -nolisten tcp', 'npm', 'run', name]);
  report.connected = await verifyConnected(join(folder, 'connected'), recording);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error); }
finally { await save(); console.log(`Linux verification ${report.status}: ${join(folder, 'validation.json')}`); }
