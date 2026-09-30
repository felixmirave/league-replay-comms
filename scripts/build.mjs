import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts', 'sync/entry': 'src/sync/entry.ts', 'analysis/hash-entry': 'src/analysis/hash-entry.ts', 'analysis/decoder-entry': 'src/analysis/decoder-entry.ts', 'analysis/ocr-entry': 'src/analysis/ocr-entry.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true,
});
await buildRenderer();
