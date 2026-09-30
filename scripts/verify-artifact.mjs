import assert from 'node:assert/strict';
import { extractFile } from '@electron/asar';
import { readFile, open, stat, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyNativeDirectory } from './windows-native.mjs';
import { verifyNotices } from './notices.mjs';
import { verifyPortablePayload } from './portable-payload.mjs';

const { version, commsValidation } = JSON.parse(await readFile('package.json', 'utf8'));
const executable = `release/LeagueReplayComms-${version}-x64.exe`;
assert((await stat(executable)).size > 1024 * 1024, 'Portable artifact is missing or incomplete');
const packagedManifest = JSON.parse(extractFile('release/win-unpacked/resources/app.asar', 'package.json').toString('utf8'));
assert.equal(packagedManifest.version, version, 'Stale packaged application version');
assert.deepEqual(packagedManifest.commsValidation, commsValidation, 'Stale packaged validation capabilities');
for (const name of await readdir('dist', { recursive: true })) {
  if (!(await stat(`dist/${name}`)).isFile()) continue;
  const archived = extractFile('release/win-unpacked/resources/app.asar', `dist/${name.replaceAll('\\', '/')}`);
  assert(archived.equals(await readFile(`dist/${name}`)), `Stale packaged module: ${name}`);
}
const ocr = JSON.parse(await readFile('resources/ocr/verified.json', 'utf8'));
for (const [name, hash] of Object.entries(ocr.files)) {
  const staged = await readFile(`release/win-unpacked/resources/ocr/${name}`);
  assert.equal(createHash('sha256').update(staged).digest('hex'), hash, `Stale packaged clock resource: ${name}`);
}
for (const name of ['scripts/heartbeat.lua', 'scripts/discover-league.ps1', 'scripts/edit-replay-config.ps1', 'scripts/elevate-replay-config.ps1', 'certificates/riotgames.pem']) assert((await readFile(`release/win-unpacked/resources/${name}`)).equals(await readFile(`resources/${name}`)), `Stale resource: ${name}`);
const manifest = JSON.parse(await readFile('resources/bin/win32-x64/verified.json', 'utf8'));
for (const [name, hash] of Object.entries(manifest.files)) {
  const staged = await readFile(`release/win-unpacked/resources/bin/win32-x64/${name}`);
  assert.equal(createHash('sha256').update(staged).digest('hex'), hash, `Stale packaged native resource: ${name}`);
}
await verifyNativeDirectory('release/win-unpacked/resources/bin/win32-x64');
await verifyNotices(process.cwd(), 'release/win-unpacked/resources/notices');
for (const name of await readdir('resources/native-docs', { recursive: true })) {
  if (!(await stat(`resources/native-docs/${name}`)).isFile()) continue;
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
