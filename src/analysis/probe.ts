import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { probeSchema, type MediaProbe, type MediaStream } from '../shared/media';

export interface MediaProber {
  inspect(path: string, signal?: AbortSignal): Promise<MediaProbe>;
  inspectRanges?(path: string, probe: MediaProbe, signal?: AbortSignal): Promise<MediaProbe>;
}
const numeric = z.union([z.string(), z.number()]).optional();
const rawSchema = z.object({
  format: z.object({ format_name: z.string(), start_time: numeric, duration: numeric }).optional(),
  streams: z.array(z.object({ index: z.number().int().nonnegative(), codec_type: z.string(), codec_name: z.string().optional(),
    start_time: numeric, duration: numeric, channels: z.number().int().positive().optional(),
    disposition: z.object({ attached_pic: z.number().optional() }).optional(), tags: z.record(z.string(), z.string()).optional(),
  })).max(256),
});
function number(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '' || value === 'N/A') return;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}
function durationTag(text?: string): number | undefined {
  const match = text?.match(/^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined;
}
export function parseProbe(raw: unknown): MediaProbe {
  const data = rawSchema.parse(raw);
  const formats = data.format?.format_name.split(',') ?? [];
  const streams: MediaStream[] = data.streams.flatMap(stream => {
    if ((stream.codec_type !== 'audio' && stream.codec_type !== 'video') || stream.disposition?.attached_pic) return [];
    const tags = Object.fromEntries(Object.entries(stream.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const duration = number(stream.duration);
    return [{ index: stream.index, type: stream.codec_type, codec: stream.codec_name ?? 'unknown', channels: stream.channels, title: tags.title, language: tags.language,
      startPtsSeconds: number(stream.start_time), durationSeconds: duration !== undefined && duration > 0 ? duration : undefined,
      // In ffmpeg's Matroska output this tag is the ending PTS, not a duration
      // relative to the first packet. Validate other muxers with decoded evidence.
      taggedEndPtsSeconds: formats.includes('matroska') && /^Lavc/i.test(tags.encoder ?? '') ? durationTag(tags.duration) : undefined,
    }];
  });
  if (!streams.some(stream => stream.type === 'audio')) throw new Error('Recording contains no playable audio stream');
  const duration = number(data.format?.duration);
  return probeSchema.parse({ formats, startPtsSeconds: number(data.format?.start_time), durationSeconds: duration !== undefined && duration > 0 ? duration : undefined, streams });
}

/** A bounded native probe; no media decoding or full-file buffering in JavaScript. */
export class Ffprobe implements MediaProber {
  constructor(private readonly executable: string) {}
  async inspect(path: string, signal?: AbortSignal): Promise<MediaProbe> {
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      const child = spawn(this.executable, ['-v', 'error', '-probesize', '10000000', '-analyzeduration', '5000000', '-show_format', '-show_streams', '-of', 'json', resolve(path)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = Buffer.alloc(0), diagnostics = '', failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; child.kill(); };
      const abort = () => stop(new Error('Media inspection cancelled'));
      const deadline = setTimeout(() => stop(new Error('Media inspection timed out. The recording may be damaged or unavailable.')), 15000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => {
        if (failure) return;
        if (output.length + data.length > 1_000_000) stop(new Error('Recording metadata exceeds the supported size'));
        else output = Buffer.concat([output, data]);
      });
      child.stderr.on('data', data => { diagnostics = (diagnostics + String(data)).slice(-4000); });
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        clearTimeout(deadline); signal?.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new Error(`Could not inspect recording: ${diagnostics.trim() || `ffprobe exited (${code})`}`)); return; }
        try { accept(parseProbe(JSON.parse(output.toString('utf8')))); } catch (error) { reject(error); }
      });
      if (signal?.aborted) abort();
    });
  }

  /** Container indexes sometimes omit track duration. Scan packets in the background
   * instead of guessing it from the container. Memory remains bounded independently
   * of recording length; no audio or video is decoded. */
  async inspectRanges(path: string, probe: MediaProbe, signal?: AbortSignal): Promise<MediaProbe> {
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      const child = spawn(this.executable, ['-v', 'error', '-select_streams', 'a', '-show_packets', '-show_entries', 'packet=stream_index,pts_time,duration_time', '-of', 'compact=p=0:nk=0', resolve(path)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '', diagnostics = '', failure: Error | undefined;
      const ranges = new Map<number, { startPtsSeconds: number; endPtsSeconds: number }>();
      const stop = (error: Error) => { failure ??= error; child.kill(); };
      const abort = () => stop(new Error('Audio timing analysis cancelled'));
      const deadline = setTimeout(() => stop(new Error('Audio timing analysis timed out. Try a local copy of the recording.')), 300000);
      signal?.addEventListener('abort', abort, { once: true });
      const line = (line: string) => {
        const fields = Object.fromEntries(line.split('|').map(field => { const split = field.indexOf('='); return [field.slice(0, split), field.slice(split + 1)]; }));
        const index = number(fields.stream_index), pts = number(fields.pts_time), duration = number(fields.duration_time);
        if (index === undefined || pts === undefined || !probe.streams.some(stream => stream.type === 'audio' && stream.index === index)) return;
        const end = pts + Math.max(0, duration ?? 0);
        const previous = ranges.get(index);
        ranges.set(index, { startPtsSeconds: Math.min(previous?.startPtsSeconds ?? pts, pts), endPtsSeconds: Math.max(previous?.endPtsSeconds ?? end, end) });
      };
      child.stdout.on('data', data => {
        if (failure) return;
        buffer += String(data);
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        if (buffer.length > 65536) stop(new Error('Invalid packet timing output'));
      });
      child.stderr.on('data', data => { diagnostics = (diagnostics + String(data)).slice(-4000); });
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        clearTimeout(deadline); signal?.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new Error(`Could not read audio timing: ${diagnostics.trim() || code}`)); return; }
        if (buffer.trim()) line(buffer);
        try {
          accept(probeSchema.parse({ ...probe, streams: probe.streams.map(stream => ({ ...stream, packetRange: ranges.get(stream.index) ?? stream.packetRange })) }));
        } catch (error) { reject(error); }
      });
      if (signal?.aborted) abort();
    });
  }
}
