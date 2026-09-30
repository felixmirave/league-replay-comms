import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectPe, verifyImports, verifyNativeDirectory } from './windows-native.mjs';

test('pinned native payload includes every static DLL and imported Vulkan function', async () => {
  const images = await verifyNativeDirectory('resources/bin/win32-x64');
  const vulkanImports = images.get('mpv.exe').imports.get('vulkan-1.dll');
  assert.equal(vulkanImports.length, 10);
  assert.equal(images.has('d3dcompiler_43.dll'), false);

  // Reproduce the missing-loader defect from the previous payload.
  const missing = new Map(images); missing.delete('vulkan-1.dll');
  assert.throws(() => verifyImports(missing), /mpv.exe: required DLL vulkan-1.dll is missing/);

  // A DLL with the right filename but an incompatible export table is insufficient.
  const incompatible = new Map(images), loader = images.get('vulkan-1.dll');
  const exports = new Set(loader.exports); exports.delete('vkGetInstanceProcAddr');
  incompatible.set('vulkan-1.dll', { ...loader, exports });
  assert.throws(() => verifyImports(incompatible), /lacks imported symbol vkGetInstanceProcAddr/);
});

test('dependency inspection rejects damaged and wrong-architecture executable headers', async () => {
  const original = await readFile('resources/bin/win32-x64/vulkan-1.dll');
  assert.throws(() => inspectPe(original.subarray(0, 100), 'truncated.dll'), /truncated PE data/);
  const changed = Buffer.from(original);
  changed.writeUInt16LE(0x14c, changed.readUInt32LE(0x3c) + 4);
  assert.throws(() => inspectPe(changed, 'wrong-architecture.dll'), /expected an x64 PE32\+ image/);
});
