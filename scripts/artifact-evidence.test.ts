import type { ArtifactRecord } from './artifact-evidence.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { digestFile, verifiedArtifact } from './artifact-evidence.ts';

test('binds verification to exact artifact bytes and refuses missing runtime evidence', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'comms-artifact-evidence-'));
  const path = join(folder, 'fixture.exe');
  try {
    await writeFile(path, 'MZfixture-one');
    const sha256 = await digestFile(path);
    const payloadFiles = Object.fromEntries(['League Replay Comms.exe', 'resources/app.asar', 'resources/bin/win32-x64/mpv.exe', 'resources/bin/win32-x64/ffmpeg.exe', 'resources/bin/win32-x64/ffprobe.exe', 'resources/notices/THIRD_PARTY_NOTICES.html'].map(name => [name, sha256]));
    const report: ArtifactRecord = { schemaVersion: 1, artifact: 'fixture.exe', bytes: (await readFile(path)).length, sha256, payloadFiles };
    await writeFile(`${path}.verification.json`, JSON.stringify(report));
    assert.equal((await verifiedArtifact(path)).sha256, sha256);
    await assert.rejects(verifiedArtifact(path, { requireIsolatedProfile: true }), /isolated-profile support/);
    report.commsValidation = { profileArgumentVersion: 1 };
    await writeFile(`${path}.verification.json`, JSON.stringify(report));
    assert.equal((await verifiedArtifact(path, { requireIsolatedProfile: true })).commsValidation!.profileArgumentVersion, 1);
    await writeFile(path, 'MZfixture-two');
    await assert.rejects(verifiedArtifact(path), /changed since verification/);
    await writeFile(path, 'MZfixture-one');
    delete report.payloadFiles['resources/app.asar'];
    await writeFile(`${path}.verification.json`, JSON.stringify(report));
    await assert.rejects(verifiedArtifact(path), /Missing verified payload/);
    report.artifact = 'another.exe';
    await writeFile(`${path}.verification.json`, JSON.stringify(report));
    await assert.rejects(verifiedArtifact(path), /another artifact/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
