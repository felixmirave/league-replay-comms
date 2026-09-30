import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ffprobe } from '../../src/analysis/probe';
import { MediaDecoder } from '../../src/analysis/decoder';
import { fileVersion } from '../../src/library/identity';
import { MediaEngine } from '../../src/sync/engine';

const run = promisify(execFile);
const enabled = !!(process.env.COMMS_TEST_FFMPEG && process.env.COMMS_TEST_FFPROBE && process.env.COMMS_TEST_MPV);
const sampleRate = 48000, duration = 3;
const pulses = [0.5, 2];

function sourcePcm(): Buffer {
  const output = Buffer.alloc(44 + sampleRate * duration * 2);
  output.write('RIFF'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36); output.writeUInt32LE(output.length - 44, 40);
  for (const [index, start] of pulses.entries()) {
    for (let frame = 0; frame < 3840; frame++) {
      const envelope = Math.sin(Math.PI * frame / 3839) ** 2;
      const value = Math.round(26000 * envelope * Math.sin(2 * Math.PI * (index ? 1700 : 1000) * frame / sampleRate));
      output.writeInt16LE(value, 44 + (start * sampleRate + frame) * 2);
    }
  }
  return output;
}

describe.skipIf(!enabled)('compressed audio timing with real priming metadata', () => {
  for (const codec of [
    { extension: 'mp3', encoder: 'libmp3lame', bitrate: '192k', negativePacket: false },
    { extension: 'm4a', encoder: 'aac', bitrate: '192k', negativePacket: true },
    { extension: 'ogg', encoder: 'libopus', bitrate: '128k', negativePacket: true },
  ]) it(`keeps ${codec.extension} waveform and precise seeks on the decoded timeline`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'comms-codec-'));
    const source = join(folder, 'original.wav'), path = join(folder, `encoded.${codec.extension}`);
    const engine = new MediaEngine(process.env.COMMS_TEST_MPV!, resolve('resources/scripts/heartbeat.lua'), 'null');
    try {
      await writeFile(source, sourcePcm());
      await run(process.env.COMMS_TEST_FFMPEG!, ['-hide_banner', '-loglevel', 'error', '-i', source, '-c:a', codec.encoder, '-b:a', codec.bitrate, path], { timeout: 30000 });
      const packets = JSON.parse((await run(process.env.COMMS_TEST_FFPROBE!, ['-v', 'error', '-select_streams', 'a:0', '-read_intervals', '%+#2', '-show_packets', '-of', 'json', path], { timeout: 30000 })).stdout).packets;
      expect(packets[0].side_data_list.some((item: { skip_samples?: number }) => (item.skip_samples ?? 0) > 0)).toBe(true);
      if (codec.negativePacket) expect(Number(packets[0].pts_time)).toBeLessThan(0);
      // Independently decode frame timestamps; do not infer origin from format
      // duration or assume that compressed content begins at packet PTS zero.
      const frames = JSON.parse((await run(process.env.COMMS_TEST_FFPROBE!, ['-v', 'error', '-select_streams', 'a:0', '-show_frames', '-show_entries', 'frame=pts_time,nb_samples', '-of', 'json', path], { timeout: 30000 })).stdout).frames;
      const firstDecodedPts = Number(frames[0].pts_time);
      expect(Number.isFinite(firstDecodedPts)).toBe(true);
      const probe = await new Ffprobe(process.env.COMMS_TEST_FFPROBE!).inspect(path);
      const opened = await engine.load(path, probe);
      const originSeconds = opened.originSeconds!;
      expect(Number.isFinite(originSeconds)).toBe(true);
      const stream = probe.streams.find(stream => stream.type === 'audio')!;
      const version = await fileVersion(path);
      const decoder = new MediaDecoder(process.env.COMMS_TEST_FFMPEG!);
      const full = await decoder.decode({ kind: 'waveform', path, version, streamIndex: stream.index, originSeconds,
        sampleRate, startSeconds: 0, endSeconds: opened.durationSeconds, bucketSeconds: 0.005 });
      if (full.kind !== 'waveform') throw new Error('Expected a waveform');
      const offset = firstDecodedPts - originSeconds;
      for (const start of pulses) {
        const expected = start + offset;
        const audible = full.peaks.filter(peak => peak[0] > expected - 0.15 && peak[0] < expected + 0.2 && Math.max(-peak[2], peak[3]) > 0.2);
        expect(audible.length).toBeGreaterThan(6);
        expect(audible[0]![0]).toBeGreaterThanOrEqual(expected - 0.01);
        expect(audible[0]![0]).toBeLessThan(expected + 0.04);
        expect(audible.at(-1)![1]).toBeLessThanOrEqual(expected + 0.09);
      }
      const target = pulses[1]! + offset + 0.04;
      const excerpt = await decoder.decode({ kind: 'waveform', path, version, streamIndex: stream.index, originSeconds,
        sampleRate, startSeconds: target - 0.2, endSeconds: target + 0.2, bucketSeconds: 0.005 });
      if (excerpt.kind !== 'waveform') throw new Error('Expected a waveform');
      const fullPulse = full.peaks.filter(peak => peak[0] > target - 0.1 && Math.max(-peak[2], peak[3]) > 0.2);
      const seekedPulse = excerpt.peaks.filter(peak => Math.max(-peak[2], peak[3]) > 0.2);
      expect(seekedPulse.length).toBeGreaterThan(6);
      expect(Math.abs(seekedPulse[0]![0] - fullPulse[0]![0])).toBeLessThanOrEqual(0.006);
      for (const [rate, position] of [[2, target], [0.5, pulses[0]! + offset + 0.04], [1, target]] as const) {
        await engine.rate(rate);
        const sample = await engine.seek(position);
        expect(sample.paused).toBe(true);
        expect(sample.rate).toBeCloseTo(rate, 5);
        expect(Math.abs(sample.positionSeconds - position)).toBeLessThan(0.012);
      }
    } finally { await engine.close(); await rm(folder, { recursive: true, force: true }); }
  }, 60000);
});
