import { build, Platform, Arch } from 'electron-builder';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// The builder defaults to 7z level 9 even with "normal" compression. Bound build
// memory so the portable artifact can also be produced on modest CI runners.
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= '5';
const mode = process.argv[2];
if (mode === 'stage') {
  await build({ targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64) });
} else if (mode === 'portable') {
  const { name, version } = JSON.parse(await readFile('package.json', 'utf8'));
  // An interrupted 7z run can leave a newer but incomplete cached archive.
  await rm(`release/${name}-${version}-x64.nsis.7z`, { force: true });
  await build({ targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64), prepackaged: 'release/win-unpacked' });
} else {
  // Release ASAR construction memory before starting native compression.
  for (const stage of ['stage', 'portable']) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/package-win.ts', stage], { stdio: 'inherit', env: process.env });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Packaging ${stage} failed (${code})`)));
    });
  }
}
