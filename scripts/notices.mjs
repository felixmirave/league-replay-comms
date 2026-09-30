import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const noticeName = /^(licen[cs]e|copying|copyright|notice)([._-]|$)/i;
const maxNoticeBytes = 4 * 1024 * 1024;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function filename(value) {
  assert(typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !value.includes('..') && !value.endsWith('.'), `Unsafe notice filename: ${value}`);
  assert(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), `Reserved Windows filename: ${value}`);
  return value;
}

function relativePath(value) {
  assert(typeof value === 'string' && value.length && !value.includes('\\') && !value.includes(':') && !value.startsWith('/'), `Unsafe notice path: ${value}`);
  for (const part of value.split('/')) filename(part.replace(/^@/, ''));
  return value;
}

function httpsUrl(value) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password, `Expected an HTTPS notice source: ${value}`);
}

export function validateManifest(manifest, lock, native) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported notice manifest');
  assert(Array.isArray(manifest.components) && manifest.components.length, 'No notice components');
  assert(Array.isArray(manifest.unresolved) && manifest.unresolved.every(value => typeof value === 'string'), 'Missing notice coverage status');
  assert(manifest.requirements?.packages && manifest.requirements?.nativeArtifacts, 'Notice input requirements missing');
  assert.deepEqual(Object.keys(manifest.requirements.nativeArtifacts).sort(), native.artifacts.map(artifact => artifact.name).sort(), 'Notice audit must cover the current native artifact set');
  for (const [name, version] of Object.entries(manifest.requirements.packages)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `Notice audit must be updated for ${name}`);
  }
  for (const [name, hash] of Object.entries(manifest.requirements.nativeArtifacts)) {
    assert.equal(native.artifacts.find(artifact => artifact.name === name)?.sha256, hash, `Notice audit must be updated for ${name}`);
  }
  const ids = new Set();
  for (const component of manifest.components) {
    const id = filename(component.id).toLowerCase();
    assert(!ids.has(id), `Duplicate notice component: ${id}`); ids.add(id);
    assert(typeof component.name === 'string' && component.name.length, `Component name missing: ${id}`);
    httpsUrl(component.sourceUrl);
    assert(component.notes === undefined || (Array.isArray(component.notes) && component.notes.every(note => typeof note === 'string')), `Invalid notes: ${id}`);
    assert(Array.isArray(component.files) && component.files.length, `No notice files: ${id}`);
    const names = new Set();
    for (const file of component.files) {
      const name = filename(file.name).toLowerCase();
      assert(!names.has(name), `Duplicate notice file: ${id}/${name}`); names.add(name);
      assert(/^[a-f0-9]{64}$/.test(file.sha256), `Invalid notice checksum: ${id}/${name}`);
      httpsUrl(file.url);
    }
  }
}

async function inputs(root) {
  const [manifestBytes, lockBytes, nativeBytes] = await Promise.all([
    readFile(join(root, 'scripts/notices-manifest.json')),
    readFile(join(root, 'package-lock.json')),
    readFile(join(root, 'resources/native-manifest.json')),
  ]);
  const manifest = JSON.parse(manifestBytes), lock = JSON.parse(lockBytes), native = JSON.parse(nativeBytes);
  validateManifest(manifest, lock, native);
  return { manifest, lock, manifestDigest: digest(manifestBytes), lockDigest: digest(lockBytes), nativeDigest: digest(nativeBytes) };
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `Notice download failed (${response.status}): ${url}`);
  httpsUrl(response.url);
  assert(response.body, `Empty notice download: ${url}`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert(length <= maxNoticeBytes, `Notice download exceeds 4 MiB: ${url}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function pinnedFile(root, file, fetchBytes) {
  const cache = join(root, '.cache/notices', file.sha256);
  const cached = await readFile(cache).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (cached && digest(cached) === file.sha256) return cached;
  const bytes = Buffer.from(await fetchBytes(file.url));
  assert(bytes.length > 0 && bytes.length <= maxNoticeBytes, `Invalid notice size: ${file.name}`);
  assert.equal(digest(bytes), file.sha256, `Notice checksum mismatch: ${file.url}`);
  await mkdir(dirname(cache), { recursive: true });
  const temp = `${cache}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, cache); }
  finally { await rm(temp, { force: true }); }
  return bytes;
}

async function replaceDirectory(stage, destination) {
  const backup = `${destination}.previous-${randomUUID()}`;
  let previous = false;
  try { await rename(destination, backup); previous = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(stage, destination); }
  catch (error) { if (previous) await rename(backup, destination); throw error; }
  if (previous) await rm(backup, { recursive: true, force: true });
}

function renderIndex(inventory, texts) {
  const sections = inventory.components.map(component => `<section><h2>${escapeHtml(component.name)}${component.version ? ` ${escapeHtml(component.version)}` : ''}</h2>
${component.sourceUrl ? `<p><a href="${escapeHtml(component.sourceUrl)}">Upstream source</a>${component.sourceCommit ? ` · revision ${escapeHtml(component.sourceCommit)}` : ''}</p>` : ''}
${(component.notes ?? []).map(note => `<p>${escapeHtml(note)}</p>`).join('\n')}
${component.files.map(file => `<details><summary>${escapeHtml(file.name)}</summary><pre>${escapeHtml(texts.get(file.path).toString('utf8'))}</pre></details>`).join('\n')}</section>`).join('\n');
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>League Replay Comms — third-party notices</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;padding:0 1rem;max-width:70rem;color:#17212b}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace}h2{margin-top:2rem}summary{cursor:pointer;padding:.5rem;background:#f0f3f6}a{color:#075a9d}</style>
<h1>Third-party notices</h1>
<p>League Replay Comms uses the components listed below. Complete collected texts are available offline here and in the neighboring files; upstream links require a connection. This inventory records collected notices and known gaps. It does not certify complete corresponding-source coverage.</p>
<p>The local Tesseract.js Node worker was bundled with esbuild and a banner that disables runtime fetch. Original package notices are retained. This software is based in part on the work of the Independent JPEG Group.</p>
<p>Additional preserved notices: <a href="../native-docs/ffmpeg/LICENSE">FFmpeg GPL license</a>, <a href="../native-docs/ffmpeg/README.txt">FFmpeg build information</a>, <a href="../native-docs/vulkan-loader/LICENSE">Electron license</a>, <a href="../native-docs/vulkan-loader/LICENSES.chromium.html">Chromium and Vulkan notices</a>.</p>
<details><summary>Unresolved distribution coverage</summary><ul>${inventory.unresolved.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul></details>
${sections}
</html>\n`;
}

export async function prepareNotices({ root = process.cwd(), fetchBytes = download } = {}) {
  const { manifest, lock, ...digests } = await inputs(root);
  const components = [], texts = new Map();
  for (const component of manifest.components) {
    const files = [];
    for (const file of component.files) {
      const path = `upstream/${component.id}/${file.name}`;
      texts.set(path, await pinnedFile(root, file, fetchBytes));
      files.push({ ...file, path });
    }
    components.push({ ...component, kind: 'upstream', files });
  }
  for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!location || entry.dev) continue;
    relativePath(location);
    assert(location.startsWith('node_modules/'), `Unexpected production package location: ${location}`);
    const folder = join(root, location), pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
    assert.equal(pkg.version, entry.version, `Installed package differs from lockfile: ${location}`);
    const files = [];
    for (const file of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !noticeName.test(file.name)) continue;
      filename(file.name);
      const bytes = await readFile(join(folder, file.name));
      const path = `npm/${location}/${file.name}`;
      texts.set(path, bytes); files.push({ name: file.name, path, sha256: digest(bytes) });
    }
    if (!files.length) {
      assert(manifest.components.some(component => component.npmPackage === pkg.name && component.version === pkg.version), `No full notice collected for ${pkg.name}@${pkg.version}; update the notice manifest`);
      continue;
    }
    components.push({ id: `npm/${location}`, kind: 'npm', name: pkg.name, version: pkg.version, sourceUrl: entry.resolved,
      notes: [`Copied from the installed production package at ${location}, version checked against package-lock.json.`], files });
  }
  const inventory = { schemaVersion: 1, ...digests, components, unresolved: manifest.unresolved };
  texts.set('THIRD_PARTY_NOTICES.html', Buffer.from(renderIndex(inventory, texts)));
  inventory.files = Object.fromEntries([...texts].map(([path, bytes]) => [path, digest(bytes)]));
  const destination = join(root, 'resources/notices'), stage = `${destination}.stage-${randomUUID()}`;
  try {
    await mkdir(stage, { recursive: true });
    for (const [path, bytes] of texts) {
      const target = join(stage, relativePath(path));
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
    }
    await writeFile(join(stage, 'verified.json'), `${JSON.stringify(inventory, null, 2)}\n`);
    await replaceDirectory(stage, destination);
  } finally { await rm(stage, { recursive: true, force: true }); }
  return inventory;
}

export async function verifyNotices(root = process.cwd(), directory = join(root, 'resources/notices')) {
  const { manifest, lock: _lock, ...digests } = await inputs(root);
  const inventory = JSON.parse(await readFile(join(directory, 'verified.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error('Dependency notices missing. Run npm run prepare:notices.');
    throw error;
  }));
  assert.equal(inventory.schemaVersion, 1, 'Unsupported notice inventory');
  for (const [key, value] of Object.entries(digests)) assert.equal(inventory[key], value, `Stale notices (${key}). Run npm run prepare:notices.`);
  assert.deepEqual(inventory.unresolved, manifest.unresolved, 'Notice coverage qualifications changed');
  for (const component of manifest.components) for (const file of component.files) {
    assert.equal(inventory.files[`upstream/${component.id}/${file.name}`], file.sha256, `Pinned notice absent: ${component.id}/${file.name}`);
  }
  assert(inventory.files['THIRD_PARTY_NOTICES.html'], 'Readable notice index missing');
  for (const [path, sha256] of Object.entries(inventory.files)) {
    assert.equal(digest(await readFile(join(directory, relativePath(path)))), sha256, `Notice changed after preparation: ${path}`);
  }
  return inventory;
}
