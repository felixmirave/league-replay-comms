import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileVersion } from '../library/identity';
import { sameFileVersion } from '../library/model';
import { frameRequestSchema, frameSchema, type FrameRequest, type DecodedFrame } from '../shared/analysis';
import { frameMediaTime } from '../shared/media';

/** Runs inside a worker. Native decoding and streamed metadata keep memory bounded. */
export class MediaDecoder {
  constructor(private readonly executable: string) {}
  async decode(raw: FrameRequest, signal?: AbortSignal): Promise<DecodedFrame> {
    const request = frameRequestSchema.parse(raw);
    if (!sameFileVersion(request.version, await fileVersion(request.path))) throw new Error('Recording changed before clock decoding');
    const result = await this.frame(request, signal);
    if (!sameFileVersion(request.version, await fileVersion(request.path))) throw new Error('Recording changed during clock decoding');
    return result;
  }
  private input(path: string, absolutePts: number): string[] {
    // Decode from the preceding keyframe and trim explicitly in original PTS.
    // Accurate input seeking with copyts can discard valid nonzero-start footage.
    return ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-threads', '1', '-filter_threads', '1', '-copyts',
      ...(absolutePts > 0 ? ['-noaccurate_seek', '-seek_timestamp', '1', '-ss', absolutePts.toFixed(9)] : []), '-i', resolve(path)];
  }
  private async frame(request: FrameRequest, signal?: AbortSignal): Promise<DecodedFrame> {
    const target = request.positionSeconds + request.originSeconds;
    const crop = request.crop;
    // "after" receives a decoded frame's timestamp. Compare integer PTS so
    // decimal rounding cannot return the same frame instead of its successor.
    const select = request.after ? `select=gt(pts\\,round(${target.toFixed(9)}/TB))` : `select=gte(t\\,${target.toFixed(9)})`;
    const filters = [select, `crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y}`, 'scale=480:120:force_original_aspect_ratio=decrease', 'format=gray', 'showinfo'];
    let timeBase: number | undefined, pts: number | undefined;
    const png = await this.run([...this.input(request.path, Math.max(0, target - 0.1)), '-map', `0:${request.streamIndex}`, '-an', '-sn', '-dn', '-vf', filters.join(','), '-frames:v', '1', '-fps_mode', 'passthrough', '-c:v', 'png', '-threads', '1', '-f', 'image2pipe', 'pipe:1'], signal, line => {
      if (!line.includes('showinfo')) return;
      const base = line.match(/config in time_base:\s*(\d+)\/(\d+)/);
      if (base && Number(base[2]) > 0) timeBase = Number(base[1]) / Number(base[2]);
      const frame = line.match(/\bn:\s*0\s+pts:\s*(-?\d+)/);
      if (frame && timeBase !== undefined && pts === undefined) pts = Number(frame[1]) * timeBase;
    });
    if (pts === undefined || png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('No video frame at this position.');
    return frameSchema.parse({ ptsSeconds: pts, positionSeconds: frameMediaTime(pts, request.originSeconds), width: png.readUInt32BE(16), height: png.readUInt32BE(20), png });
  }
  private async run(args: string[], signal: AbortSignal | undefined, line: (text: string) => void): Promise<Buffer> {
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      const child = spawn(this.executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let bytes = 0, buffer = '', diagnostics = '', failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; child.kill(); };
      const abort = () => stop(new Error('Clock decoding cancelled'));
      const deadline = setTimeout(() => stop(new Error('Clock decoding timed out')), 45000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => { if (failure) return; bytes += data.length; if (bytes > 1_000_000) stop(new Error('Decoded clock image exceeds the memory limit')); else chunks.push(data); });
      child.stderr.on('data', data => {
        if (failure) return;
        diagnostics = (diagnostics + String(data)).slice(-4000); buffer += String(data);
        try {
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
          if (buffer.length > 65536) throw new Error('Invalid decoder metadata');
        } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
      });
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        clearTimeout(deadline); signal?.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new Error(`Could not decode clock image: ${diagnostics.trim() || code}`)); return; }
        try { if (buffer.trim()) line(buffer); accept(Buffer.concat(chunks, bytes)); } catch (error) { reject(error); }
      });
      if (signal?.aborted) abort();
    });
  }
}
