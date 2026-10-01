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
  inject: ['scripts/ocr-offline-guard.ts'],
});
// Node loads the .js + .wasm pairs. The .wasm.js browser bundles embed another
// copy of each WASM binary. Keep every Node core, including SIMD fallbacks:
// the pinned worker can select a full core even with OEM.LSTM_ONLY.
await cp('node_modules/tesseract.js-core', `${root}/node_modules/tesseract.js-core`, {
  recursive: true, filter: source => !source.endsWith('.wasm.js'),
});
await cp('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', `${root}/eng.traineddata.gz`);
await cp('node_modules/tesseract.js/LICENSE.md', `${root}/TESSERACT_JS_LICENSE.md`);
const versions: Record<string, string> = {};
for (const name of ['tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng']) versions[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version;
const files: Record<string, string> = {};
async function hashFiles(folder: string, prefix = '') {
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
