import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

export async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifiedArtifact(executable, { requireIsolatedProfile = false } = {}) {
  const recordPath = `${executable}.verification.json`;
  assert((await stat(recordPath)).size < 4 * 1024 * 1024, 'Artifact verification record exceeds limit');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(record.schemaVersion, 1, 'Unsupported artifact verification record');
  assert.equal(record.artifact, basename(executable), 'Verification record names another artifact');
  assert.equal(record.bytes, (await stat(executable)).size, 'Artifact size changed since verification');
  assert.equal(record.sha256, await digestFile(executable), 'Artifact changed since verification');
  for (const name of ['League Replay Comms.exe', 'resources/app.asar', 'resources/bin/win32-x64/mpv.exe', 'resources/bin/win32-x64/ffmpeg.exe', 'resources/bin/win32-x64/ffprobe.exe', 'resources/notices/THIRD_PARTY_NOTICES.html']) {
    assert(/^[a-f0-9]{64}$/.test(record.payloadFiles?.[name]), `Missing verified payload file: ${name}`);
  }
  if (requireIsolatedProfile) assert.equal(record.commsValidation?.profileArgumentVersion, 1, 'Artifact does not declare isolated-profile support; rebuild before execution testing');
  return record;
}
