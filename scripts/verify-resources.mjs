import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyNativeDirectory } from './windows-native.mjs';
import { verifyNotices } from './notices.mjs';

for (const path of ['resources/bin/win32-x64/mpv.exe', 'resources/bin/win32-x64/ffmpeg.exe', 'resources/bin/win32-x64/ffprobe.exe', 'resources/scripts/heartbeat.lua', 'resources/scripts/discover-league.ps1', 'resources/scripts/edit-replay-config.ps1', 'resources/scripts/elevate-replay-config.ps1', 'resources/certificates/riotgames.pem']) {
  try { if (!(await stat(path)).isFile()) throw new Error(); }
  catch { throw new Error(`Required packaged resource missing: ${path}. Run npm run prepare:native.`); }
}
const verified = JSON.parse(await readFile('resources/bin/win32-x64/verified.json', 'utf8'));
const manifest = JSON.parse(await readFile('resources/native-manifest.json', 'utf8'));
if (JSON.stringify(verified.artifacts) !== JSON.stringify(manifest.artifacts.map(a => a.sha256))) throw new Error('Prepared native resources do not match the pinned manifest');
const nativeFiles = manifest.artifacts.flatMap(a => a.requiredFiles).sort();
assert.deepEqual(Object.keys(verified.files).sort(), nativeFiles, 'Native checksums differ from the manifest');
assert.deepEqual((await readdir('resources/bin/win32-x64')).sort(), [...nativeFiles, 'verified.json'].sort(),
  'Unexpected native files. Run npm run prepare:native.');
for (const name of nativeFiles) {
  const path = `resources/bin/win32-x64/${name}`;
  const file = await readFile(path);
  if (file[0] !== 0x4d || file[1] !== 0x5a) throw new Error(`Not a Windows executable: ${path}`);
  if (createHash('sha256').update(file).digest('hex') !== verified.files[name]) throw new Error(`Native resource changed after preparation: ${path}`);
}
const documentation = [];
for (const name of await readdir('resources/native-docs', { recursive: true })) {
  if ((await stat(`resources/native-docs/${name}`)).isFile()) documentation.push(name.replaceAll('\\', '/'));
}
assert.deepEqual(documentation.sort(), manifest.artifacts.flatMap(a => a.documentationFiles.map(name => `${a.name}/${name}`)).sort(),
  'Native documentation differs from the manifest. Run npm run prepare:native.');
const ocr = JSON.parse(await readFile('resources/ocr/verified.json', 'utf8').catch(() => { throw new Error('Offline clock resources missing. Run npm run prepare:ocr.'); }));
if (ocr.version !== 1 || ocr.lockDigest !== createHash('sha256').update(await readFile('package-lock.json')).digest('hex')) throw new Error('Clock resources do not match the lockfile. Run npm run prepare:ocr.');
assert(!Object.keys(ocr.files).some(name => name.endsWith('.wasm.js')), 'Browser OCR bundles are still prepared. Run npm run prepare:ocr.');
for (const [name, hash] of Object.entries(ocr.files)) {
  if (createHash('sha256').update(await readFile(`resources/ocr/${name}`)).digest('hex') !== hash) throw new Error(`Clock resource changed after preparation: ${name}`);
}
await verifyNativeDirectory('resources/bin/win32-x64');
const notices = await verifyNotices();
console.log(`Native, offline clock, and ${notices.components.length} notice entries verified; required heartbeat and Riot certificate present. Windows release validation remains a separate gate.`);
