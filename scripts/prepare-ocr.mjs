import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// npm ci supplies integrity-checked, locked inputs; no runtime download is needed.
const root = 'resources/ocr';
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await build({ entryPoints: ['node_modules/tesseract.js/src/worker-script/node/index.js'], outfile: `${root}/worker.cjs`, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', external: ['tesseract.js-core/*'],
  banner: { js: 'globalThis.fetch = async () => { throw new Error("Clock recognition uses bundled resources only"); };' },
});
await cp('node_modules/tesseract.js-core', `${root}/node_modules/tesseract.js-core`, { recursive: true });
await cp('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', `${root}/eng.traineddata.gz`);
await cp('node_modules/tesseract.js/LICENSE.md', `${root}/TESSERACT_JS_LICENSE.md`);
const versions = {};
for (const name of ['tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng']) versions[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version;
const files = {};
async function hashFiles(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await hashFiles(join(folder, entry.name), `${relative}/`);
    else files[relative] = createHash('sha256').update(await readFile(join(folder, entry.name))).digest('hex');
  }
}
await hashFiles(root);
const lockDigest = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
await writeFile(`${root}/verified.json`, JSON.stringify({ version: 1, lockDigest, versions, files }, null, 2));
console.log('Prepared offline clock worker, local WASM variants, and English data from locked packages.');
