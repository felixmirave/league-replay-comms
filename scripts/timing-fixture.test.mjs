import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { writeTimingFixture } from './timing-fixture.mjs';
import { digestFile } from './artifact-evidence.mjs';

test('writes bounded PCM with identifiable markers, exact sample times and content evidence', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'comms-timing-'));
  const path = join(folder, 'reference.wav');
  try {
    const report = await writeTimingFixture(path, 6);
    const wav = await readFile(path);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(4) + 8, wav.length);
    assert.equal(wav.readUInt32LE(24), 48000); assert.equal(wav.length, 44 + 6 * 48000 * 2);
    assert(wav.subarray(44, 44 + 48000 * 2).every(value => value === 0));
    assert(wav.subarray(44 + 5 * 48000 * 2).every(value => value === 0));
    for (const marker of report.markers) assert.equal(wav.readInt16LE(44 + marker.sample * 2), 8192);
    assert(wav.subarray(44 + 72000 * 2, 44 + 73000 * 2).some(value => value !== 0), 'Pause pilot is missing between markers');
    assert.notDeepEqual(wav.subarray(44 + 48000 * 2, 44 + 2 * 48000 * 2), wav.subarray(44 + 2 * 48000 * 2, 44 + 3 * 48000 * 2));
    assert.equal(report.sha256, await digestFile(path));
    assert.deepEqual(JSON.parse(await readFile(`${path}.markers.json`, 'utf8')), report);
    await assert.rejects(writeTimingFixture(path, 6), /EEXIST/);
    assert.equal(await digestFile(path), report.sha256);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('refuses invalid durations and preserves preexisting marker files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'comms-timing-'));
  const path = join(folder, 'reference.wav');
  try {
    await assert.rejects(writeTimingFixture(path, NaN), /Duration/);
    await writeFile(`${path}.markers.json`, 'previous data');
    await assert.rejects(writeTimingFixture(path, 6), /EEXIST/);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.equal(await readFile(`${path}.markers.json`, 'utf8'), 'previous data');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
