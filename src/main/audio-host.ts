import { BrowserWindow } from 'electron';
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { Ffprobe } from '../analysis/probe';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { audioErrorMessage, type AudioRequest, type AudioReply } from '../shared/audio-engine';

/** Private loopback transport serves only bundled assets and the selected track.
 * Native FFmpeg preserves format support; PCM stays streaming and bounded.
 */
export class AudioHost {
  private window?: BrowserWindow;
  private server?: Server;
  private rootUrl = '';
  private source?: { path: string; index: number; channels: number; origin: number; duration: number; token: string };
  private decoders = new Set<ChildProcess>();
  private initializing?: Promise<void>;
  private rendererFailed = false;
  constructor(private assets: string, private ffmpeg: string, private muted = false) {}
  private initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const token = randomBytes(24).toString('hex');
      const server = this.server = createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? '', 'http://127.0.0.1');
          if (!url.pathname.startsWith(`/${token}/`)) { response.writeHead(404).end(); return; }
          const file = url.pathname.slice(token.length + 2);
          if (file === 'pcm') {
            const source = this.source;
            const start = Number(url.searchParams.get('start'));
            if (!source || url.searchParams.get('source') !== source.token || !Number.isSafeInteger(start) || start < 0 || start > Math.ceil(source.duration * 48000)) { response.writeHead(404).end(); return; }
            const seconds = source.origin + start / 48000;
            // Keep decoder preroll; trim on our authoritative source timeline instead
            // of FFmpeg's automatic seek trim relative to its container origin.
            // first_pts uses the input sample rate. Convert to 48 kHz before
            // applying our 48 kHz cursor, including padding delayed tracks.
            const decoder = spawn(this.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-copyts', '-seek_timestamp', '1', '-noaccurate_seek', '-ss', String(seconds), '-i', source.path,
              '-map', `0:a:${source.index}`, '-vn', '-af', `asetpts=PTS-(${source.origin})/TB,aresample=48000,aresample=48000:async=1:first_pts=${start},pan=stereo|c0=c0|c1=c${source.channels === 1 ? 0 : 1}`, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            this.decoders.add(decoder);
            let sent = false;
            decoder.stdout!.once('data', () => { sent = true; });
            response.setHeader('Content-Type', 'application/octet-stream');
            decoder.stdout!.pipe(response, { end: false });
            decoder.stderr!.resume();
            decoder.on('error', () => response.destroy());
            // close follows stdout drainage; exit can arrive with unread PCM.
            decoder.on('close', code => {
              this.decoders.delete(decoder);
              if (response.destroyed) return;
              if (code !== 0 || !sent) response.destroy(new Error('Audio decoding failed'));
              else response.end();
            });
            response.on('close', () => { decoder.kill('SIGKILL'); this.decoders.delete(decoder); });
            return;
          }
          const types: Record<string, string> = { 'index.html': 'text/html', 'player.js': 'text/javascript', 'ahead-worker.js': 'text/javascript', 'timeline-worklet.js': 'text/javascript', 'deepfilter-module.js': 'text/javascript', 'deepfilter.wasm': 'application/wasm' };
          if (!types[file]) { response.writeHead(404).end(); return; }
          response.setHeader('Content-Type', types[file]!);
          response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; style-src 'none'");
          if (file === 'index.html') response.end('<!doctype html><html><head><meta charset="utf-8"><title>Comms audio</title></head><body><script src="./player.js"></script></body></html>');
          else { await stat(join(this.assets, file)); createReadStream(join(this.assets, file)).pipe(response); }
        })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not start local audio transport.');
      this.rootUrl = `http://127.0.0.1:${address.port}/${token}/`;
      const window = this.window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
      window.webContents.on('render-process-gone', () => { this.rendererFailed = true; this.stopDecoders(); });
      window.webContents.setAudioMuted(this.muted);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadURL(`${this.rootUrl}index.html`);
      // loadURL waits for the bundled script to initialize the engine.
      await window.webContents.executeJavaScript('Boolean(globalThis.audioEngine)');
    })();
    return this.initializing;
  }
  async handle(message: AudioRequest): Promise<AudioReply> {
    try {
      if (this.rendererFailed) { this.close(); this.initializing = undefined; this.rendererFailed = false; }
      await this.initialize();
      const operation = { ...message.operation };
      if (operation.type === 'load') {
        this.stopDecoders();
        // The path comes from the sync process, never from the HTTP client.
        await stat(operation.path);
        const channels = operation.channels ?? (await new Ffprobe(join(dirname(this.ffmpeg), basename(this.ffmpeg).replace('ffmpeg', 'ffprobe'))).inspect(operation.path)).streams.filter(stream => stream.type === 'audio')[operation.audioIndex]?.channels;
        if (!channels) throw new Error('Could not read the selected track’s channel count.');
        this.source = { channels, path: operation.path, index: operation.audioIndex, origin: operation.origin, duration: operation.duration, token: randomBytes(24).toString('hex') };
      }
      if (operation.type === 'interrupt' || operation.type === 'close') { this.stopDecoders(); this.source = undefined; }
      const result = await this.window!.webContents.executeJavaScript(`globalThis.audioEngine.run(${JSON.stringify({ ...operation, ...(operation.type === 'load' ? { source: `${this.rootUrl}pcm?source=${this.source!.token}` } : {}) })}).then(data => ({ data }), error => ({ error: error && typeof error.message === 'string' ? error.message : String(error) }))`);
      return { type: 'audio-reply', id: message.id, ...result };
    } catch (error) { return { type: 'audio-reply', id: message.id, error: audioErrorMessage(error) }; }
  }
  // A canceled pipe can block FFmpeg's graceful flush; these decoders only
  // produce disposable PCM, so terminate them without waiting for that flush.
  private stopDecoders() { for (const child of this.decoders) child.kill('SIGKILL'); this.decoders.clear(); }
  close() { this.stopDecoders(); this.window?.destroy(); this.server?.close(); this.server?.closeAllConnections(); }
}
