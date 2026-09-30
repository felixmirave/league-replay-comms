import assert from 'node:assert/strict';
import { open, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { digestFile } from './artifact-evidence.mjs';

const sampleRate = 48_000, amplitude = 8192;

/** Synthetic measurement input, not a recording-time metadata integration. */
export async function writeTimingFixture(path, durationSeconds = 2400) {
  assert(Number.isInteger(durationSeconds) && durationSeconds >= 6 && durationSeconds <= 3600, 'Duration must be an integer between 6 and 3600 seconds');
  const markerPath = `${path}.markers.json`;
  let wav, manifest, wavCreated = false, manifestCreated = false, success = false;
  try {
    wav = await open(path, 'wx'); wavCreated = true;
    manifest = await open(markerPath, 'wx'); manifestCreated = true;
    const bytes = durationSeconds * sampleRate * 2;
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
    await wav.writeFile(header);
    const markers = [];
    for (let second = 0; second < durationSeconds; second++) {
      const pcm = Buffer.alloc(sampleRate * 2);
      if (second > 0 && second < durationSeconds - 1) {
        // Continuous pilot makes pause/resume observable between coded markers.
        // It cannot by itself prove that playback resumed at the correct moment.
        for (let frame = 0; frame < sampleRate; frame++) pcm.writeInt16LE(Math.round(1024 * Math.sin(2 * Math.PI * 440 * frame / sampleRate)), frame * 2);
        // A precisely placed decaying click marks the integer recording second.
        for (let frame = 0; frame < 288; frame++) pcm.writeInt16LE(pcm.readInt16LE(frame * 2) + Math.round(amplitude * Math.exp(-7 * frame / 288) * Math.cos(2 * Math.PI * 2000 * frame / sampleRate)), frame * 2);
        // Twelve LSB-first tone bits identify the second after a 50 ms gap. The
        // payload helps distinguish repeated markers after seeks; it is not an anchor finder.
        for (let bit = 0; bit < 12; bit++) {
          const frequency = second & (1 << bit) ? 3500 : 2000;
          const start = 2400 + bit * 672;
          for (let frame = 0; frame < 384; frame++) {
            const envelope = Math.sin(Math.PI * frame / 383) ** 2;
            pcm.writeInt16LE(pcm.readInt16LE((start + frame) * 2) + Math.round(amplitude * envelope * Math.sin(2 * Math.PI * frequency * frame / sampleRate)), (start + frame) * 2);
          }
        }
        markers.push({ second, sample: second * sampleRate, mediaSeconds: second });
      }
      await wav.writeFile(pcm);
    }
    await wav.sync(); await wav.close(); wav = undefined;
    const result = { schemaVersion: 1, kind: 'synthetic-time-coded-audio', file: basename(path), sha256: await digestFile(path),
      sampleRate, channels: 1, bitsPerSample: 16, durationSeconds, markerAmplitudeDbfs: -12.04, pilotHz: 440, pilotAmplitudeDbfs: -30.1,
      encoding: { onset: 'First sample of a 6 ms decaying 2 kHz click over the continuous pilot', bits: 12, order: 'least-significant-first',
        zeroHz: 2000, oneHz: 3500, payloadStartSeconds: 0.05, bitPeriodSeconds: 0.014, toneDurationSeconds: 0.008 }, markers };
    await manifest.writeFile(JSON.stringify(result, null, 2) + '\n'); await manifest.sync();
    success = true;
    return result;
  } finally {
    await wav?.close(); await manifest?.close();
    if (!success) {
      // Delete only outputs whose exclusive creation succeeded in this call.
      if (wavCreated) await rm(path, { force: true });
      if (manifestCreated) await rm(markerPath, { force: true });
    }
  }
}
