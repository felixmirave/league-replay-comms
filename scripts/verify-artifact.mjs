import assert from 'node:assert/strict';
import { extractFile, listPackage } from '@electron/asar';
import { readFile, open, stat, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';
import { verifyNativeDirectory } from './windows-native.mjs';
import { verifyNotices } from './notices.mjs';
import { verifyPortablePayload } from './portable-payload.mjs';

const { version, commsValidation } = JSON.parse(await readFile('package.json', 'utf8'));
const executable = `release/LeagueReplayComms-${version}-x64.exe`;
assert((await stat(executable)).size > 1024 * 1024, 'Portable artifact is missing or incomplete');
// Check the actual PE resources: a configured icon alone does not establish
// that resource editing ran for both the portable launcher and Electron app.
const icon = Data.IconFile.from(await readFile('build/icon.ico'));
const iconBytes = item => Buffer.from(item.isRaw() ? item.bin : item.generate());
for (const path of [executable, 'release/win-unpacked/League Replay Comms.exe']) {
  const resources = NtExecutableResource.from(NtExecutable.from(await readFile(path)));
  const group = Resource.IconGroupEntry.fromEntries(resources.entries)[0];
  assert(group, `Missing application icon: ${path}`);
  const actual = group.getIconItemsFromEntries(resources.entries);
  assert.equal(actual.length, icon.icons.length, `Missing icon resolutions: ${path}`);
  for (const { data } of icon.icons) {
    // PE icon-group dimensions encode 256 pixels as zero.
    assert(actual.some(item => (item.width || 256) === data.width && (item.height || 256) === data.height && iconBytes(item).equals(iconBytes(data))),
      `Incorrect ${data.width}×${data.height} icon: ${path}`);
  }
}
console.log(`Verified ${icon.icons.length} icon resolutions in the launcher and application executables.`);
const packagedManifest = JSON.parse(extractFile('release/win-unpacked/resources/app.asar', 'package.json').toString('utf8'));
const packagedFiles = listPackage('release/win-unpacked/resources/app.asar').map(name => name.replaceAll('\\', '/'));
assert(!packagedFiles.some(name => name === '/node_modules' || name.startsWith('/node_modules/')), 'Redundant npm packages are present in the ASAR');
assert(!packagedFiles.some(name => name.endsWith('.map')), 'Source maps are present in the ASAR');
assert.deepEqual((await readdir('release/win-unpacked/locales')).sort(), ['en-GB.pak', 'en-US.pak'], 'Unexpected Electron locales');
await assert.rejects(stat('release/win-unpacked/LICENSES.chromium.html'), { code: 'ENOENT' }, 'Duplicate Chromium notices are present');
assert.equal(packagedManifest.version, version, 'Stale packaged application version');
assert.deepEqual(packagedManifest.commsValidation, commsValidation, 'Stale packaged validation capabilities');
for (const name of await readdir('dist', { recursive: true })) {
  if (!(await stat(`dist/${name}`)).isFile()) continue;
  const archived = extractFile('release/win-unpacked/resources/app.asar', `dist/${name.replaceAll('\\', '/')}`);
  assert(archived.equals(await readFile(`dist/${name}`)), `Stale packaged module: ${name}`);
}
const ocr = JSON.parse(await readFile('resources/ocr/verified.json', 'utf8'));
const packagedOcrFiles = [];
for (const name of await readdir('release/win-unpacked/resources/ocr', { recursive: true })) {
  if ((await stat(`release/win-unpacked/resources/ocr/${name}`)).isFile()) packagedOcrFiles.push(name.replaceAll('\\', '/'));
}
assert(!packagedOcrFiles.some(name => name.endsWith('.wasm.js')), 'Browser OCR bundles are present');
assert.deepEqual(packagedOcrFiles.sort(), [...Object.keys(ocr.files), 'verified.json'].sort(), 'Unexpected packaged OCR resources');
for (const [name, hash] of Object.entries(ocr.files)) {
  const staged = await readFile(`release/win-unpacked/resources/ocr/${name}`);
  assert.equal(createHash('sha256').update(staged).digest('hex'), hash, `Stale packaged clock resource: ${name}`);
}
for (const name of ['scripts/heartbeat.lua', 'scripts/discover-league.ps1', 'scripts/edit-replay-config.ps1', 'scripts/elevate-replay-config.ps1', 'certificates/riotgames.pem']) assert((await readFile(`release/win-unpacked/resources/${name}`)).equals(await readFile(`resources/${name}`)), `Stale resource: ${name}`);
const manifest = JSON.parse(await readFile('resources/bin/win32-x64/verified.json', 'utf8'));
const nativeSpec = JSON.parse(await readFile('resources/native-manifest.json', 'utf8'));
assert.deepEqual(manifest.artifacts, nativeSpec.artifacts.map(a => a.sha256), 'Native resources differ from the pinned manifest');
assert.deepEqual(Object.keys(manifest.files).sort(), nativeSpec.artifacts.flatMap(a => a.requiredFiles).sort(), 'Native checksums differ from the manifest');
assert.deepEqual((await readdir('release/win-unpacked/resources/bin/win32-x64')).sort(), [...Object.keys(manifest.files), 'verified.json'].sort(), 'Unexpected packaged native files');
assert((await readFile('release/win-unpacked/resources/bin/win32-x64/verified.json')).equals(await readFile('resources/bin/win32-x64/verified.json')), 'Stale packaged native checksums');
for (const [name, hash] of Object.entries(manifest.files)) {
  const staged = await readFile(`release/win-unpacked/resources/bin/win32-x64/${name}`);
  assert.equal(createHash('sha256').update(staged).digest('hex'), hash, `Stale packaged native resource: ${name}`);
}
await verifyNativeDirectory('release/win-unpacked/resources/bin/win32-x64');
await verifyNotices(process.cwd(), 'release/win-unpacked/resources/notices');
assert((await readFile('release/win-unpacked/resources/native-manifest.json')).equals(await readFile('resources/native-manifest.json')), 'Stale packaged native manifest');
const expectedDocumentation = nativeSpec.artifacts.flatMap(a => a.documentationFiles.map(name => `${a.name}/${name}`));
const packagedDocumentation = [];
for (const name of await readdir('release/win-unpacked/resources/native-docs', { recursive: true })) {
  if ((await stat(`release/win-unpacked/resources/native-docs/${name}`)).isFile()) packagedDocumentation.push(name.replaceAll('\\', '/'));
}
assert.deepEqual(packagedDocumentation.sort(), expectedDocumentation.sort(), 'Unexpected packaged native documentation');
for (const name of expectedDocumentation) {
  assert((await readFile(`release/win-unpacked/resources/native-docs/${name}`)).equals(await readFile(`resources/native-docs/${name}`)), `Stale native documentation: ${name}`);
}
const handle = await open(executable);
const header = Buffer.alloc(2);
try { await handle.read(header, 0, 2, 0); } finally { await handle.close(); }
assert.equal(header.toString(), 'MZ', 'Portable artifact is not a Windows executable');
console.log('Extracting the embedded portable payload and comparing it with the staged build…');
const payloadFiles = await verifyPortablePayload(executable, 'release/win-unpacked');
const hash = createHash('sha256');
for await (const chunk of createReadStream(executable, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
const checksum = hash.digest('hex');
await writeFile(`${executable}.sha256`, `${checksum}  ${executable.split('/').at(-1)}\n`);
await writeFile(`${executable}.verification.json`, `${JSON.stringify({ schemaVersion: 1, artifact: executable.split('/').at(-1), sha256: checksum,
  bytes: (await stat(executable)).size, verifiedAt: new Date().toISOString(), payloadFiles, commsValidation: packagedManifest.commsValidation, windowsExecutionVerified: false }, null, 2)}\n`);
console.log(`Verified portable artifact, ${Object.keys(payloadFiles).length} extracted files, and staged modules/resources: ${executable}`);
console.log(`SHA-256: ${checksum}`);
console.log('Execution on clean Windows and live-client accuracy remain unverified.');
