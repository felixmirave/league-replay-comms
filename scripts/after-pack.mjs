import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export default async function afterPack({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== 'win32') return;
  // Keep the copy referenced by the offline notices page in both development
  // and packaged builds. Refuse to deduplicate if the pinned Electron versions
  // diverge and their notice contents no longer match.
  const duplicate = join(appOutDir, 'LICENSES.chromium.html');
  const retained = join(appOutDir, 'resources/native-docs/vulkan-loader/LICENSES.chromium.html');
  const [runtimeNotices, nativeNotices] = await Promise.all([readFile(duplicate), readFile(retained)]);
  assert(runtimeNotices.equals(nativeNotices), 'Electron and Vulkan-loader notices differ; update the pinned resources before deduplicating');
  await unlink(duplicate);
}
