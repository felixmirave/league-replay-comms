import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileVersion } from '../library/identity';
import { sameFileVersion } from '../library/model';
import { decodeRequestSchema, frameSchema, waveformSchema, type DecodeRequest, type DecodeResult, type FrameRequest, type PreviewFrame, type WaveformChunk, type WaveformPeak, type WaveformRequest } from '../shared/analysis';
import { frameMediaTime } from '../shared/media';

/** Runs inside a worker. Native decoding and streamed metadata keep memory bounded. */
export class MediaDecoder {
  constructor(private readonly executable: string) {}
  async decode(raw: DecodeRequest, signal?: AbortSignal): Promise<DecodeResult> {
    const request = decodeRequestSchema.parse(raw);
    if (!sameFileVersion(request.version, await fileVersion(request.path))) throw new Error('Recording changed before preview analysis');
    const result = request.kind === 'frame' ? await this.frame(request, signal) : await this.waveform(request, signal);
    if (!sameFileVersion(request.version, await fileVersion(request.path))) throw new Error('Recording changed during preview analysis');
    return result;
  }
  private input(path: string, absolutePts: number): string[] {
    // Decode from the preceding keyframe and trim explicitly in original PTS.
    // Accurate input seeking with copyts can discard valid nonzero-start footage.
    return ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-threads', '1', '-filter_threads', '1', '-copyts',
      ...(absolutePts > 0 ? ['-noaccurate_seek', '-seek_timestamp', '1', '-ss', absolutePts.toFixed(9)] : []), '-i', resolve(path)];
  }
  private async frame(request: FrameRequest, signal?: AbortSignal): Promise<PreviewFrame> {
    const target = request.positionSeconds + request.originSeconds;
    const crop = request.crop;
    const scale = request.processing === 'clock' ? ['scale=480:120:force_original_aspect_ratio=decrease', 'format=gray'] : ['scale=1280:720:force_original_aspect_ratio=decrease'];
    // "after" receives a decoded frame's timestamp. Compare integer PTS so
    // decimal rounding cannot return the same frame instead of its successor.
    const select = request.after ? `select=gt(pts\\,round(${target.toFixed(9)}/TB))` : `select=gte(t\\,${target.toFixed(9)})`;
    const filters = [select, ...(crop ? [`crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y}`] : []), ...scale, 'showinfo'];
    let timeBase: number | undefined, pts: number | undefined;
    const png = await this.run([...this.input(request.path, Math.max(0, target - 0.1)), '-map', `0:${request.streamIndex}`, '-an', '-sn', '-dn', '-vf', filters.join(','), '-frames:v', '1', '-fps_mode', 'passthrough', '-c:v', 'png', '-threads', '1', '-f', 'image2pipe', 'pipe:1'], signal, line => {
      if (!line.includes('showinfo')) return;
      const base = line.match(/config in time_base:\s*(\d+)\/(\d+)/);
      if (base && Number(base[2]) > 0) timeBase = Number(base[1]) / Number(base[2]);
      const frame = line.match(/\bn:\s*0\s+pts:\s*(-?\d+)/);
      if (frame && timeBase !== undefined && pts === undefined) pts = Number(frame[1]) * timeBase;
    }, 8_000_000);
    if (pts === undefined || png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('No video frame at this position. Choose an earlier point in the recording.');
    return frameSchema.parse({ kind: 'frame', ptsSeconds: pts, positionSeconds: frameMediaTime(pts, request.originSeconds), width: png.readUInt32BE(16), height: png.readUInt32BE(20), dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  }
  private async waveform(request: WaveformRequest, signal?: AbortSignal): Promise<WaveformChunk> {
    const start = request.startSeconds + request.originSeconds, end = request.endSeconds + request.originSeconds;
    const samples = Math.max(1, Math.round(request.sampleRate * request.bucketSeconds));
    const peaks: WaveformPeak[] = [];
    let pending: { start: number; end: number; min?: number } | undefined;
    const filter = `atrim=start=${start.toFixed(9)}:end=${end.toFixed(9)},aformat=sample_fmts=flt,asetnsamples=n=${samples}:p=0,ashowinfo,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Min_level+Max_level,ametadata=mode=print`;
    await this.run([...this.input(request.path, Math.max(0, start - 0.5)), '-map', `0:${request.streamIndex}`, '-vn', '-sn', '-dn', '-af', filter, '-c:a', 'pcm_f32le', '-f', 'null', '-'], signal, line => {
      if (line.includes('ashowinfo')) {
        const match = line.match(/\bpts:(-?\d+).*?\brate:(\d+)\s+nb_samples:(\d+)/);
        if (match) {
          const rate = Number(match[2]);
          if (rate !== request.sampleRate || !line.includes('fmt:flt')) throw new Error('Unexpected waveform sample format');
          const at = Number(match[1]) / rate - request.originSeconds;
          pending = { start: at, end: at + Number(match[3]) / rate };
        }
      }
      if (!pending || !line.includes('ametadata')) return;
      const low = line.match(/lavfi\.astats\.Overall\.Min_level=([-+\d.eE]+)/);
      if (low) pending.min = Number(low[1]);
      const high = line.match(/lavfi\.astats\.Overall\.Max_level=([-+\d.eE]+)/);
      if (high && pending.min !== undefined) {
        const max = Number(high[1]);
        if (![pending.start, pending.end, pending.min, max].every(Number.isFinite)) throw new Error('Invalid waveform timing or amplitude');
        peaks.push([pending.start, pending.end, Math.max(-1, Math.min(1, pending.min)), Math.max(-1, Math.min(1, max))]);
        if (peaks.length > 25001) throw new Error('Waveform exceeds the preview memory limit');
        pending = undefined;
      }
    }, 0);
    return waveformSchema.parse({ kind: 'waveform', startSeconds: request.startSeconds, endSeconds: request.endSeconds, bucketSeconds: samples / request.sampleRate, peaks });
  }
  private async run(args: string[], signal: AbortSignal | undefined, line: (text: string) => void, limit: number): Promise<Buffer> {
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      const child = spawn(this.executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let bytes = 0, buffer = '', diagnostics = '', failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; child.kill(); };
      const abort = () => stop(new Error('Preview analysis cancelled'));
      const deadline = setTimeout(() => stop(new Error('Preview analysis timed out')), 45000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => { if (failure) return; bytes += data.length; if (bytes > limit) stop(new Error('Decoded preview exceeds the memory limit')); else chunks.push(data); });
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
        if (code !== 0) { reject(new Error(`Could not decode preview: ${diagnostics.trim() || code}`)); return; }
        try { if (buffer.trim()) line(buffer); accept(Buffer.concat(chunks, bytes)); } catch (error) { reject(error); }
      });
      if (signal?.aborted) abort();
    });
  }
}
