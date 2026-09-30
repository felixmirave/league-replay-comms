import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Structural build check, not a Windows loader emulator. PE32+ fields follow:
// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
export function inspectPe(bytes, name) {
  const check = (condition, message) => assert(condition, `${name}: ${message}`);
  const bounds = (offset, size) => { check(Number.isSafeInteger(offset) && offset >= 0 && offset + size <= bytes.length, 'truncated PE data'); return offset; };
  const u16 = offset => bytes.readUInt16LE(bounds(offset, 2));
  const u32 = offset => bytes.readUInt32LE(bounds(offset, 4));
  const u64 = offset => bytes.readBigUInt64LE(bounds(offset, 8));
  check(u16(0) === 0x5a4d, 'missing MZ header');
  const pe = u32(0x3c), optional = pe + 24, optionalSize = u16(pe + 20), sections = u16(pe + 6);
  check(u32(pe) === 0x00004550 && u16(pe + 4) === 0x8664 && u16(optional) === 0x20b, 'expected an x64 PE32+ image');
  check(sections > 0 && sections <= 96 && optionalSize >= 112, 'invalid PE header');
  bounds(optional, optionalSize);
  const directoryCount = u32(optional + 108);
  check(directoryCount <= (optionalSize - 112) / 8, 'invalid directory count');
  const table = optional + optionalSize;
  bounds(table, sections * 40);
  function offset(rva, length = 1) {
    if (rva < u32(optional + 60)) return bounds(rva, length);
    for (let i = 0; i < sections; i++) {
      const section = table + i * 40, start = u32(section + 12), rawSize = u32(section + 16);
      if (rva >= start && rva - start + length <= rawSize) return bounds(u32(section + 20) + rva - start, length);
    }
    throw new Error(`${name}: RVA is outside file-backed sections`);
  }
  function string(rva) {
    const start = offset(rva), end = bytes.indexOf(0, start);
    check(end >= start && end - start <= 4096, 'invalid PE string');
    offset(rva, end - start + 1);
    return bytes.toString('ascii', start, end);
  }
  const directory = index => index < directoryCount ? { rva: u32(optional + 112 + index * 8), size: u32(optional + 116 + index * 8) } : { rva: 0, size: 0 };
  const delayed = directory(13);
  check(!delayed.rva && !delayed.size, 'delay imports require review before packaging');
  const imports = new Map(), imported = directory(1);
  if (imported.rva) {
    let terminated = false;
    for (let i = 0; i < Math.min(Math.floor(imported.size / 20), 4096); i++) {
      const descriptor = offset(imported.rva + i * 20, 20);
      if ([0, 4, 8, 12, 16].every(field => u32(descriptor + field) === 0)) { terminated = true; break; }
      const dll = string(u32(descriptor + 12)).toLowerCase();
      check(/^[a-z0-9_.-]+\.dll$/.test(dll), 'invalid import DLL');
      const thunk = u32(descriptor) || u32(descriptor + 16), symbols = [];
      let ended = false;
      for (let index = 0; index < 65536; index++) {
        const entry = u64(offset(thunk + index * 8, 8));
        if (!entry) { ended = true; break; }
        if (entry >> 63n) symbols.push(Number(entry & 0xffffn));
        else { check(entry <= 0xffffffffn, 'invalid import name RVA'); symbols.push(string(Number(entry) + 2)); }
      }
      check(ended, 'unterminated import table');
      // A linker can emit multiple descriptors for the same DLL, including
      // differently cased names. Every descriptor's symbols still need checking.
      imports.set(dll, [...(imports.get(dll) ?? []), ...symbols]);
    }
    check(terminated, 'unterminated import directory');
  }
  const exports = new Set(), forwarded = new Set(), exported = directory(0);
  if (exported.rva) {
    const header = offset(exported.rva, 40), base = u32(header + 16), count = u32(header + 20), names = u32(header + 24);
    check(count <= 65536 && names <= 65536, 'oversized export table');
    const functions = u32(header + 28), pointers = u32(header + 32), ordinals = u32(header + 36);
    for (let i = 0; i < count; i++) {
      const target = u32(offset(functions + i * 4, 4));
      if (!target) continue;
      exports.add(base + i);
      if (target >= exported.rva && target < exported.rva + exported.size) forwarded.add(base + i);
    }
    for (let i = 0; i < names; i++) {
      const ordinal = u16(offset(ordinals + i * 2, 2));
      check(ordinal < count, 'invalid export ordinal');
      const symbol = string(u32(offset(pointers + i * 4, 4)));
      if (exports.has(base + ordinal)) exports.add(symbol);
      if (forwarded.has(base + ordinal)) forwarded.add(symbol);
    }
  }
  return { imports, exports, forwarded };
}

// Explicit Windows 10/11 system components; API-set contracts are resolved by
// Windows. A new third-party DLL must be bundled, never presumed to be on PATH.
const systemDlls = new Set(`advapi32 avicap32 avrt bcrypt bcryptprimitives cfgmgr32 crypt32 d2d1 dnsapi dwmapi dwrite gdi32 imm32 iphlpapi kernel32 msimg32 msvcrt ncrypt normaliz ntdll ole32 oleaut32 opengl32 rpcrt4 secur32 setupapi shell32 shcore shlwapi user32 userenv usp10 uxtheme version winmm wldap32 ws2_32`.split(' ').map(name => `${name}.dll`));
export function verifyImports(images) {
  let bundledEdges = 0;
  for (const [name, image] of images) for (const [dll, symbols] of image.imports) {
    if (systemDlls.has(dll) || /^(api|ext)-ms-win-[a-z0-9-]+\.dll$/.test(dll)) continue;
    const dependency = images.get(dll);
    assert(dependency, `${name}: required DLL ${dll} is missing beside the native executables`);
    for (const symbol of symbols) {
      assert(dependency.exports.has(symbol), `${name}: ${dll} lacks imported symbol ${symbol}`);
      assert(!dependency.forwarded.has(symbol), `${name}: forwarded ${dll}!${symbol} requires dependency review`);
    }
    bundledEdges++;
  }
  return bundledEdges;
}
export async function verifyNativeDirectory(directory) {
  const images = new Map();
  for (const name of await readdir(directory)) if (/\.(exe|dll)$/i.test(name)) images.set(name.toLowerCase(), inspectPe(await readFile(join(directory, name)), name));
  assert(images.size, `No native Windows images found in ${directory}`);
  const edges = verifyImports(images);
  console.log(`Checked ${images.size} x64 PE images and ${edges} bundled DLL dependencies: ${directory}`);
  return images;
}
