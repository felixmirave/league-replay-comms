import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const executable = process.env.COMMS_TEST_MPV ?? (process.platform === 'win32' ? resolve('resources/bin/win32-x64/mpv.exe') : undefined);
if (!executable) throw new Error('Set COMMS_TEST_MPV to a local mpv executable, or run on Windows after npm run prepare:native.');
await access(executable);
const media = Object.fromEntries(await Promise.all(['FFMPEG', 'FFPROBE'].map(async name => {
  const path = process.env[`COMMS_TEST_${name}`] ?? (process.platform === 'win32' ? resolve(`resources/bin/win32-x64/${name.toLowerCase()}.exe`) : undefined);
  if (path) await access(path);
  return [`COMMS_TEST_${name}`, path];
})));
const test = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/integration'], {
  stdio: 'inherit', env: { ...process.env, ...media, COMMS_TEST_MPV: executable },
});
test.on('error', error => { console.error(error); process.exitCode = 1; });
test.on('exit', code => { process.exitCode = code ?? 1; });
