import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectPe, verifyImports, verifyNativeDirectory } from './windows-native.ts';

test('pinned native payload includes shared FFmpeg libraries and every imported Vulkan function', async () => {
  const images = await verifyNativeDirectory('resources/bin/win32-x64');
  const vulkanImports = images.get('mpv.exe')!.imports.get('vulkan-1.dll');
  assert.equal(vulkanImports!.length, 12);
  assert.equal(images.has('d3dcompiler_43.dll'), false);

  // Reproduce the missing-loader defect from the previous payload.
  const missing = new Map(images); missing.delete('vulkan-1.dll');
  assert.throws(() => verifyImports(missing), /mpv.exe: required DLL vulkan-1.dll is missing/);

  // A DLL with the right filename but an incompatible export table is insufficient.
  const incompatible = new Map(images), loader = images.get('vulkan-1.dll');
  assert(loader, 'Vulkan loader missing');
  const exports = new Set(loader.exports); exports.delete('vkGetInstanceProcAddr');
  incompatible.set('vulkan-1.dll', { ...loader, exports });
  assert.throws(() => verifyImports(incompatible), /lacks imported symbol vkGetInstanceProcAddr/);

  // Both CLI tools use the same codec DLL, whose own dependencies must be local.
  for (const tool of ['ffmpeg.exe', 'ffprobe.exe']) assert(images.get(tool)!.imports.has('avcodec-63.dll'));
  const missingCodec = new Map(images); missingCodec.delete('avcodec-63.dll');
  assert.throws(() => verifyImports(missingCodec), /required DLL avcodec-63.dll is missing/);
  const missingResampler = new Map(images); missingResampler.delete('swresample-7.dll');
  assert.throws(() => verifyImports(missingResampler), /avcodec-63.dll: required DLL swresample-7.dll is missing/);
  const codec = images.get('avcodec-63.dll');
  assert(codec, 'FFmpeg codec library missing');
  const codecExports = new Set(codec.exports);
  codecExports.delete('avcodec_version');
  const incompatibleCodec = new Map(images);
  incompatibleCodec.set('avcodec-63.dll', { ...codec, exports: codecExports });
  assert.throws(() => verifyImports(incompatibleCodec), /lacks imported symbol avcodec_version/);
});

test('PE inspection merges all symbols from repeated case-insensitive DLL descriptors', () => {
  // Small PE32+ image with two import descriptors for the same DLL. Keeping
  // only the last descriptor would silently miss a required exported symbol.
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(1, 70); bytes.writeUInt16LE(240, 84);
  const optional = 88;
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(bytes.length, optional + 60);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(400, optional + 120); bytes.writeUInt32LE(60, optional + 124);
  for (const [descriptor, thunk, dll, symbol, dllName, symbolName] of [
    [400, 480, 520, 580, 'Shared.DLL', 'first'], [420, 500, 540, 600, 'shared.dll', 'second'],
  ] as const) {
    bytes.writeUInt32LE(thunk, descriptor); bytes.writeUInt32LE(dll, descriptor + 12);
    bytes.writeBigUInt64LE(BigInt(symbol), thunk); bytes.write(dllName, dll); bytes.write(symbolName, symbol + 2);
  }
  const image = inspectPe(bytes, 'consumer.exe');
  assert.deepEqual(image.imports.get('shared.dll'), ['first', 'second']);
  const dependency: ReturnType<typeof inspectPe> = { imports: new Map(), exports: new Set(['second']), forwarded: new Set() };
  assert.throws(() => verifyImports(new Map([['consumer.exe', image], ['shared.dll', dependency]])), /lacks imported symbol first/);
});

test('dependency inspection rejects damaged and wrong-architecture executable headers', async () => {
  const original = await readFile('resources/bin/win32-x64/vulkan-1.dll');
  assert.throws(() => inspectPe(original.subarray(0, 100), 'truncated.dll'), /truncated PE data/);
  const changed = Buffer.from(original);
  changed.writeUInt16LE(0x14c, changed.readUInt32LE(0x3c) + 4);
  assert.throws(() => inspectPe(changed, 'wrong-architecture.dll'), /expected an x64 PE32\+ image/);
});
