import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { copyFile, rm, mkdir, readFile, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts', 'sync/entry': 'src/sync/entry.ts', 'analysis/hash-entry': 'src/analysis/hash-entry.ts', 'analysis/decoder-entry': 'src/analysis/decoder-entry.ts', 'analysis/ocr-entry': 'src/analysis/ocr-entry.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], minify: true,
});
await buildRenderer();
await copyFile('build/icon.ico', 'dist/main/icon.ico');

await mkdir('dist/audio', { recursive: true });
await build({ entryPoints: ['src/audio/player.ts'], outfile: 'dist/audio/player.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome144' });
await build({ entryPoints: ['src/audio/ahead-worker.ts'], outfile: 'dist/audio/ahead-worker.js', bundle: true, platform: 'browser', format: 'esm', target: 'chrome144' });
await build({ entryPoints: ['src/audio/timeline-worklet.ts'], outfile: 'dist/audio/timeline-worklet.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome144' });
await copyFile('node_modules/@lofcz/deepfilternet-web/dist/df_bg.wasm', 'dist/audio/deepfilter.wasm');
const binding = await readFile('node_modules/@lofcz/deepfilternet-web/dist/index.js', 'utf8');
await writeFile('dist/audio/deepfilter-module.js', binding + `
function initSync({ module }) {
  if (wasm !== undefined) return wasm;
  const compiled = module instanceof WebAssembly.Module ? module : new WebAssembly.Module(module);
  return __wbg_finalize_init(new WebAssembly.Instance(compiled, __wbg_get_imports()), compiled);
}
export { initSync, df_create_default, df_get_frame_length, df_process_frame,
  df_set_post_filter_beta, df_free };
`);
