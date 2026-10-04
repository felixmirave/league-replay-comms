import { writeFile } from 'node:fs/promises';

export const sampleRate = 48000;
export const tileSeconds = 0.125;
const fftSize = 2048;
const bases = [600, 10000];
const frequencyStep = 24;
export interface AudioFrame { at: number; rms: number; track?: number; sourceSeconds?: number; frequency?: number }

/** A unique frequency identifies each 125 ms source segment and its track.
 * Pitch-preserving playback keeps the codes readable at different replay rates.
 */
export function fixturePcm(track: number, duration = 32): Buffer {
  const base = bases[track - 1];
  if (base === undefined || duration > 32 || duration <= 0) throw new Error('Invalid coded-audio fixture');
  const pcm = Buffer.alloc(Math.round(duration * sampleRate) * 2);
  const tile = Math.round(tileSeconds * sampleRate);
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    const index = Math.floor(sample / tile), local = sample % tile;
    const envelope = Math.min(1, local / 144, (tile - 1 - local) / 144);
    const frequency = base + index * frequencyStep;
    pcm.writeInt16LE(Math.round(7000 * envelope * Math.sin(2 * Math.PI * frequency * local / sampleRate)), sample * 2);
  }
  return pcm;
}
export async function writeWav(path: string, pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  await writeFile(path, Buffer.concat([header, pcm]));
}
function spectrum(samples: Float64Array): Float64Array {
  const real = samples.slice(), imaginary = new Float64Array(fftSize);
  for (let i = 1, j = 0; i < fftSize; i++) {
    let bit = fftSize >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const value = real[i]!; real[i] = real[j]!; real[j] = value; }
  }
  for (let width = 2; width <= fftSize; width *= 2) {
    const angle = -2 * Math.PI / width;
    for (let start = 0; start < fftSize; start += width) {
      for (let j = 0; j < width / 2; j++) {
        const a = start + j, b = a + width / 2, cos = Math.cos(angle * j), sin = Math.sin(angle * j);
        const re = real[b]! * cos - imaginary[b]! * sin, im = real[b]! * sin + imaginary[b]! * cos;
        real[b] = real[a]! - re; imaginary[b] = imaginary[a]! - im;
        real[a] = real[a]! + re; imaginary[a] = imaginary[a]! + im;
      }
    }
  }
  return real.slice(0, fftSize / 2).map((re, i) => Math.hypot(re, imaginary[i]!));
}
export function analyzePcm(pcm: Buffer, origin = 0): AudioFrame[] {
  const frames: AudioFrame[] = [];
  for (let start = 0; start + fftSize <= pcm.length / 2; start += 960) {
    const samples = new Float64Array(fftSize);
    let square = 0;
    for (let i = 0; i < fftSize; i++) {
      const value = pcm.readInt16LE((start + i) * 2) / 32768;
      square += value * value;
      samples[i] = value * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }
    const frame: AudioFrame = { at: origin + (start + fftSize / 2) / sampleRate, rms: Math.sqrt(square / fftSize) };
    if (frame.rms > 0.0005) {
      const magnitudes = spectrum(samples);
      let peak = 1;
      for (let i = 2; i < magnitudes.length - 1; i++) if (magnitudes[i]! > magnitudes[peak]!) peak = i;
      const left = Math.log(magnitudes[peak - 1]! + 1e-20), center = Math.log(magnitudes[peak]! + 1e-20), right = Math.log(magnitudes[peak + 1]! + 1e-20);
      const adjustment = Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / (left - 2 * center + right)));
      const frequency = (peak + adjustment) * sampleRate / fftSize;
      frame.frequency = frequency;
      for (const [index, base] of bases.entries()) {
        const tile = Math.round((frequency - base) / frequencyStep);
        if (tile >= 0 && tile < 256 && Math.abs(frequency - (base + tile * frequencyStep)) < 10) {
          frame.track = index + 1; frame.sourceSeconds = (tile + 0.5) * tileSeconds; break;
        }
      }
    }
    frames.push(frame);
  }
  return frames;
}
export function verifyCodedAudio(frames: AudioFrame[], expected: (at: number) => number, track: number, tolerance = 0.25) {
  if (frames.length < 20) throw new Error('Insufficient captured audio');
  const audible = frames.filter(frame => frame.rms > 0.0005);
  const decoded = audible.filter(frame => frame.sourceSeconds !== undefined);
  const matching = decoded.filter(frame => frame.track === track && Math.abs(frame.sourceSeconds! - expected(frame.at)) <= tolerance);
  const result = { frames: frames.length, audible: audible.length, decoded: decoded.length, matching: matching.length,
    audibleFraction: audible.length / frames.length, matchedFraction: matching.length / frames.length,
    maxDecodedErrorSeconds: decoded.length ? Math.max(...decoded.map(frame => Math.abs(frame.sourceSeconds! - expected(frame.at)))) : null,
    rms: Math.sqrt(frames.reduce((sum, frame) => sum + frame.rms ** 2, 0) / frames.length), toleranceSeconds: tolerance };
  if (result.audibleFraction < 0.98 || result.matchedFraction < 0.9) throw new Error('Captured audio does not match independent replay timeline: ' + JSON.stringify(result));
  return result;
}
export function verifySilence(frames: AudioFrame[]) {
  if (frames.length < 20) throw new Error('Insufficient silence capture');
  const maxRms = Math.max(...frames.map(frame => frame.rms));
  if (maxRms > 0.0005) throw new Error(`Expected silence, captured RMS ${maxRms}`);
  return { frames: frames.length, maxRms };
}
/** Waveform oracle for real recordings at 1x: normalized correlation tolerates gain.
 * Downsample to 3 kHz and search the independently decoded reference, never mpv's clock.
 */
export function matchRecording(captured: Buffer, reference: Buffer, referenceStart: number) {
  const stride = 16;
  const samples = (pcm: Buffer) => {
    const result = new Float64Array(Math.floor(pcm.length / (2 * stride)));
    for (let i = 0; i < result.length; i++) {
      let sum = 0;
      for (let j = 0; j < stride; j++) sum += pcm.readInt16LE((i * stride + j) * 2) / 32768;
      result[i] = sum / stride;
    }
    return result;
  };
  const output = samples(captured), source = samples(reference), rate = sampleRate / stride;
  const width = Math.round(rate * 0.3);
  let best: { correlation: number; sourceSeconds: number; capturedSeconds: number } | undefined;
  // Select the loudest 300 ms output region; a silent source cannot establish identity.
  let targetStart = 0, largest = 0;
  for (let start = 0; start + width < output.length; start += Math.round(rate * 0.1)) {
    let energy = 0;
    for (let i = 0; i < width; i++) energy += output[start + i]! ** 2;
    if (energy > largest) { largest = energy; targetStart = start; }
  }
  if (largest / width < 1e-8) throw new Error('Captured recording is silent; choose an audible segment');
  for (let start = 0; start + width <= source.length; start++) {
    let dot = 0, energy = 0;
    for (let i = 0; i < width; i++) { const a = output[targetStart + i]!, b = source[start + i]!; dot += a * b; energy += b * b; }
    const correlation = dot / Math.sqrt(largest * energy || 1);
    if (!best || correlation > best.correlation) best = { correlation, sourceSeconds: referenceStart + start / rate, capturedSeconds: targetStart / rate };
  }
  if (!best || best.correlation < 0.8) throw new Error('Captured audio does not match decoded recording: ' + JSON.stringify(best));
  return best;
}
