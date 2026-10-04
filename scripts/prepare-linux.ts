import { spawn } from 'node:child_process';
import { readFile, mkdir, rm, lstat, symlink, unlink, writeFile, chmod, rename, access } from 'node:fs/promises';
import { delimiter, join, relative } from 'node:path';
import { projectRoot, runtimeCache, readRuntimeLock, downloadArchives, environmentKeys } from './linux-runtime.ts';

async function run(file: string, args: string[], env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { cwd: projectRoot, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${file} failed (${signal ?? code})`)));
  });
}
const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const xmlEscape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This runtime requires Debian 13 on x86_64');
  const release = await readFile('/etc/os-release', 'utf8');
  if (!/^ID=debian$/m.test(release) || !/^VERSION_ID="?13"?$/m.test(release)) throw new Error('This runtime is pinned for Debian 13; use a Debian 13 environment');
  for (const tool of ['dpkg-deb', 'openssl', 'tar']) await run('sh', ['-c', 'command -v "$1" >/dev/null || { echo "Required base tool missing: $1" >&2; exit 1; }', 'check-tool', tool]);
  const lock = await readRuntimeLock();
  const items = [lock.node, ...lock.packages];
  console.log(`Verifying/downloading ${items.length} pinned archives…`);
  const archives = await downloadArchives(items, join(runtimeCache, 'archives'));
  const runtime = join(runtimeCache, 'root');
  // Invalidate the previous environment before extraction; failed preparation must not look ready.
  await rm(join(runtimeCache, 'environment.json'), { force: true });
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  // No Debian maintainer scripts run. Every archive has been checksum verified.
  for (const path of archives.slice(1)) await run('dpkg-deb', ['-x', path, runtime]);
  await run('tar', ['-xJf', archives[0]!, '-C', runtimeCache, '--no-same-owner']);
  const node = join(runtimeCache, lock.node.name.replace(/\.tar\.xz$/, ''), 'bin');
  const env = { ...process.env };
  env.PATH = [node, join(runtime, 'usr/bin'), env.PATH ?? ''].join(delimiter);
  const libs = ['usr/lib/x86_64-linux-gnu', 'usr/lib/x86_64-linux-gnu/pulseaudio', 'usr/lib/x86_64-linux-gnu/blas', 'usr/lib/x86_64-linux-gnu/lapack', 'usr/lib/pulse-17.0+dfsg1/modules'];
  env.LD_LIBRARY_PATH = [...libs.map(path => join(runtime, path)), ...(env.LD_LIBRARY_PATH ? [env.LD_LIBRARY_PATH] : [])].join(delimiter);
  const native = join(projectRoot, 'resources/bin/linux-x64');
  await mkdir(native, { recursive: true });
  for (const name of ['mpv', 'ffmpeg', 'ffprobe']) {
    const path = join(native, name);
    let info;
    try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (info) {
      if (!info.isSymbolicLink()) throw new Error('Refusing to replace non-symlink: ' + path);
      await unlink(path);
    }
    await symlink(relative(native, join(runtime, 'usr/bin', name)), path);
  }
  const modules = join(runtime, 'usr/lib/pulse-17.0+dfsg1/modules');
  await access(modules);
  // Debian Xvfb hardcodes /usr/bin/xkbcomp. Relocate the lookup in a development-only copy.
  const xvfb = join(runtimeCache, 'Xvfb'), original = await readFile(join(runtime, 'usr/bin/Xvfb'));
  const lookup = Buffer.from('/usr/bin\0');
  const location = original.indexOf(lookup);
  if (location < 0 || original.indexOf(lookup, location + lookup.length) !== -1) throw new Error('Unexpected Xvfb compiler-path layout');
  Buffer.from('./bin\0\0\0\0').copy(original, location);
  await writeFile(xvfb + '.stage', original);
  await chmod(xvfb + '.stage', 0o755); await rename(xvfb + '.stage', xvfb);
  const wrappers = join(runtimeCache, 'bin');
  await mkdir(wrappers, { recursive: true });
  await writeFile(join(wrappers, 'Xvfb'), '#!/bin/sh\ncd ' + shellQuote(join(runtime, 'usr')) + '\nexec ' + shellQuote(xvfb) + ' "$@"\n');
  await chmod(join(wrappers, 'Xvfb'), 0o755);
  env.PATH = wrappers + delimiter + env.PATH;
  const fontconfig = join(runtimeCache, 'fonts.conf');
  await writeFile(fontconfig, '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>' + xmlEscape(join(runtime, 'usr/share/fonts')) + '</dir><cachedir>' + xmlEscape(join(runtimeCache, 'font-cache')) + '</cachedir></fontconfig>');
  Object.assign(env, { FONTCONFIG_FILE: fontconfig, COMMS_DEV_PULSE_MODULES: modules,
    COMMS_TEST_MPV: join(native, 'mpv'), COMMS_TEST_FFMPEG: join(native, 'ffmpeg'), COMMS_TEST_FFPROBE: join(native, 'ffprobe') });
  for (const args of [['ci'], ['run', 'setup:electron'], ['run', 'prepare:ocr'], ['run', 'prepare:notices']]) await run('npm', args, env);
  // Publish readiness only after dependencies and resources are prepared successfully.
  await writeFile(join(runtimeCache, 'environment.json.stage'), JSON.stringify(Object.fromEntries(environmentKeys.map(key => [key, env[key]])), null, 2) + '\n');
  await rename(join(runtimeCache, 'environment.json.stage'), join(runtimeCache, 'environment.json'));
  console.log('Ready. Run: sh scripts/linux.sh npm run verify:linux');
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
