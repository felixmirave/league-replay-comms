import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadArchive, sha256File, projectRoot } from './linux-runtime.ts';

const execute = promisify(execFile);
const digest = (data: string) => createHash('sha256').update(data).digest('hex');

test('archive download verifies cached bytes, rejects corruption, and removes partial files', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'comms-linux-download-'));
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await rm(folder, { recursive: true, force: true }); });
  const item = { name: 'fixture.deb', url: 'https://example.invalid/fixture.deb', sha256: digest('verified payload') };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('verified payload'); };
  const path = await downloadArchive(item, folder);
  assert.equal(await sha256File(path), item.sha256);
  await downloadArchive(item, folder); assert.equal(calls, 1, 'A verified cached archive must not be downloaded');
  await writeFile(path, 'corrupt cache');
  globalThis.fetch = async () => new Response('wrong download');
  await assert.rejects(downloadArchive(item, folder), /Checksum mismatch/);
  await assert.rejects(access(path + '.partial'), { code: 'ENOENT' });
  globalThis.fetch = async () => new Response('verified payload');
  await downloadArchive(item, folder);
  assert.equal(await readFile(path, 'utf8'), 'verified payload');
});

test('shell bootstrap starts TypeScript without Node on PATH and refuses a corrupt download', { timeout: 15000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'comms bootstrap space '));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const scripts = join(folder, 'scripts'), cache = join(folder, '.cache/linux');
  const name = 'node-v22.18.0-linux-x64.tar.xz', nodeDirectory = name.replace('.tar.xz', '');
  const staged = join(folder, 'staged', nodeDirectory, 'bin');
  await mkdir(staged, { recursive: true }); await mkdir(scripts); await mkdir(join(cache, 'archives'), { recursive: true });
  // A tiny executable stands in for the extracted Node payload; the bootstrap itself is unchanged.
  await writeFile(join(staged, 'node'), '#!/bin/sh\nexec ' + "'" + process.execPath.replaceAll("'", "'\\''") + "'" + ' "$@"\n');
  await chmod(join(staged, 'node'), 0o755);
  const archive = join(cache, 'archives', name);
  await execute('tar', ['-cJf', archive, '-C', join(folder, 'staged'), nodeDirectory]);
  const hash = await sha256File(archive);
  await copyFile(join(projectRoot, 'scripts/linux.sh'), join(scripts, 'linux.sh'));
  await writeFile(join(scripts, 'linux-runtime-lock.json'), JSON.stringify({ node: { name, url: 'https://nodejs.org/dist/v22.18.0/' + name, sha256: hash } }, null, 2));
  await writeFile(join(scripts, 'linux-run.ts'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const result = await execute('/bin/sh', [join(scripts, 'linux.sh'), 'node', 'argument with spaces', 'literal $(not-a-command)'], { env: { ...process.env, PATH: '/usr/bin:/bin' } });
  assert(result.stdout.includes('["node","argument with spaces","literal $(not-a-command)"]'));
  await rm(join(cache, nodeDirectory), { recursive: true }); await writeFile(archive, 'corrupt cache');
  const fakeTools = join(folder, 'fake-tools'); await mkdir(fakeTools);
  await writeFile(join(fakeTools, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; printf bad > "$1"; exit 0; fi; shift; done\nexit 1\n');
  await chmod(join(fakeTools, 'curl'), 0o755);
  await assert.rejects(execute('/bin/sh', [join(scripts, 'linux.sh'), 'node'], { env: { ...process.env, PATH: fakeTools + ':/usr/bin:/bin' } }), error => {
    assert.match(String((error as { stderr: string }).stderr), /Pinned Node checksum mismatch/); return true;
  });
  await assert.rejects(access(archive + '.partial'), { code: 'ENOENT' });
  await assert.rejects(access(join(cache, nodeDirectory)), { code: 'ENOENT' });
});

test('TypeScript launcher preserves arguments, prepared environment, project directory, and exit code', async () => {
  const launcher = join(projectRoot, 'scripts/linux-run.ts');
  const script = 'console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),mpv:process.env.COMMS_TEST_MPV}));process.exitCode=42;';
  await assert.rejects(execute(process.execPath, [launcher, 'node', '-e', script, 'space value', 'literal $(text)'], { cwd: tmpdir() }), error => {
    const result = error as { code: number; stdout: string };
    assert.equal(result.code, 42);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, ['space value', 'literal $(text)']);
    assert.equal(output.cwd, projectRoot);
    assert.equal(output.mpv, join(projectRoot, 'resources/bin/linux-x64/mpv'));
    return true;
  });
});

test('TypeScript launcher forwards termination to its child and preserves the resulting exit status', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [join(projectRoot, 'scripts/linux-run.ts'), 'node', '-e', 'process.on("SIGTERM",()=>process.exit(17));console.log("ready");setInterval(()=>{},1000);'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', () => reject(new Error('Launcher exited before child readiness')));
      child.stdout!.once('data', () => resolve());
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 17, signal: null });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
