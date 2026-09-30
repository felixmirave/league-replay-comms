import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, cp, stat, chmod, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import sevenZip from '7zip-bin';

const run = promisify(execFile);
const manifest = JSON.parse(await readFile('resources/native-manifest.json', 'utf8'));
const cache = '.cache/native';
await mkdir(cache, { recursive: true });
if (process.platform !== 'win32') await chmod(sevenZip.path7za, 0o755);
const verified = {};
const output = join('resources/bin', manifest.platform);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
for (const artifact of manifest.artifacts) {
  const archive = join(cache, `${artifact.sha256}.7z`);
  const valid = await digest(archive).then(hash => hash === artifact.sha256, () => false);
  if (!valid) {
    console.log(`Downloading pinned ${artifact.name} archive…`);
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`${artifact.name} download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.partial`));
    if (await digest(`${archive}.partial`) !== artifact.sha256) throw new Error(`${artifact.name} checksum mismatch`);
    await cp(`${archive}.partial`, archive);
    await rm(`${archive}.partial`);
  }
  const unpacked = join(cache, `unpacked-${artifact.name}`);
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  await run(sevenZip.path7za, ['x', archive, `-o${unpacked}`, '-y']);
  const sourceRoot = join(unpacked, artifact.root ?? '');
  const binaries = join(sourceRoot, artifact.binaryDirectory ?? '');
  for (const name of artifact.requiredFiles) {
    if (!(await stat(join(binaries, name))).isFile()) throw new Error(`Archive lacks ${name}`);
  }
  // Preserve documentation, but do not ship unrelated ffplay or upstream installers.
  for (const name of artifact.requiredFiles) await cp(join(binaries, name), join(output, name));
  const docs = join('resources/native-docs', artifact.name);
  await rm(docs, { recursive: true, force: true });
  if (artifact.documentationFiles) {
    await mkdir(docs, { recursive: true });
    for (const name of artifact.documentationFiles) await cp(join(sourceRoot, name), join(docs, name));
  } else await cp(sourceRoot, docs, { recursive: true, filter: source => !/\.(exe|dll|com|bat|ps1)$/i.test(source) });
  for (const name of artifact.requiredFiles) verified[name] = await digest(join(binaries, name));
  console.log(`Verified and prepared ${artifact.name}.`);
}
await writeFile(join('resources/bin', manifest.platform, 'verified.json'), JSON.stringify({ artifacts: manifest.artifacts.map(a => a.sha256), files: verified }, null, 2));
