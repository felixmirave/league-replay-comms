import type { PathLike } from 'node:fs';
import { app, BrowserWindow } from 'electron';
import type * as FileSystem from 'node:fs/promises';
import { resolve } from 'node:path';

// CommonJS keeps the same mutable fs module object used by the bundled app.
const fs: typeof FileSystem = require('node:fs/promises');
const root = process.env.COMMS_STARTUP_ROOT!;
const profile = process.env.COMMS_STARTUP_PROFILE!;
const gate = process.env.COMMS_STARTUP_GATE;
// Electron exposes this startup hook internally but omits it from public types.
(app as typeof app & { setAppPath(path: string): void }).setAppPath(root);
const probe: typeof globalThis.startupProbe = globalThis.startupProbe = { entered: false, visible: false, release: () => {} };
const pending = new Promise<void>(resolve => { probe.release = resolve; });
const target = gate === 'library' ? profile : resolve(root, 'resources/ocr/verified.json');
async function hold(path: PathLike) {
  if (resolve(String(path)) !== target) return;
  probe.entered = true;
  probe.visible = BrowserWindow.getAllWindows().some(window => window.isVisible());
  await pending;
  if (process.env.COMMS_STARTUP_FAIL === '1') throw new Error('Startup test: library unavailable');
}
// Node's overloaded fs signatures cannot express an implementation forwarding
// every overload. The wrappers preserve the original arguments and result.
if (gate === 'library') {
  const original = fs.mkdir;
  fs.mkdir = (async (...args: Parameters<typeof original>) => {
    await hold(args[0]);
    return original(...args);
  }) as typeof original;
} else {
  const original = fs.readFile;
  fs.readFile = (async (...args: Parameters<typeof original>) => {
    await hold(args[0] as PathLike);
    return original(...args);
  }) as typeof original;
}
require(resolve(root, 'dist/main/index.cjs'));
