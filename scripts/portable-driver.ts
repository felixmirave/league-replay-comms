import type * as Electron from 'electron';
import type { Runtime } from 'node:inspector';
import type { Browser } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { terminateOwned } from './validation-steps.ts';

interface ProcessExit { error?: string; code?: number | null; signal?: NodeJS.Signals | null }
export interface DesktopIdentity {
  pid: number; packaged: boolean; userData: string; sessionData: string; executable: string;
  resources: string; version: string; electron: string; portableExecutable?: string;
}
interface LaunchOptions {
  executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; profile: string;
  verifyIdentity: (identity: DesktopIdentity) => void | Promise<void>; timeoutMs?: number;
}

// NSIS does not forward the extracted Electron process's stderr. Discover both
// debugger endpoints over loopback instead of waiting for console announcements.
async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Missing reserved TCP port');
  return { port: address.port, release: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function readEndpoint(port: number, path: string) {
  return new Promise<unknown>((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path, agent: false, timeout: 1000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Debugger endpoint returned ${response.statusCode}`)); return; }
      const parts: Buffer[] = []; let bytes = 0;
      response.on('data', part => {
        bytes += part.length;
        if (bytes > 64 * 1024) { response.destroy(new Error('Debugger response exceeds limit')); return; }
        parts.push(part);
      });
      response.once('error', reject);
      response.once('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (error) { reject(error); } });
    });
    request.once('timeout', () => request.destroy(new Error('Debugger endpoint timed out')));
    request.once('error', reject);
  });
}

function localWebSocket(value: unknown, port: number) {
  assert(typeof value === 'string', 'Missing debugger WebSocket URL');
  const url = new URL(value);
  assert(url.protocol === 'ws:' && url.hostname === '127.0.0.1' && Number(url.port) === port && !url.username && !url.password, 'Debugger endpoint is not the requested loopback port');
  return url.href;
}

async function discover(port: number, node: boolean, deadline: number, exited: () => ProcessExit | undefined) {
  let lastError;
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit) throw new Error(`Desktop launcher exited before debugger discovery: ${JSON.stringify(exit)}`);
    try {
      const result = await readEndpoint(port, node ? '/json/list' : '/json/version');
      const endpoint = node ? (result as { type: string; webSocketDebuggerUrl?: string }[]).find(item => item.type === 'node')?.webSocketDebuggerUrl : (result as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
      return localWebSocket(endpoint, port);
    } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`Timed out discovering ${node ? 'Node' : 'Chromium'} debugger: ${lastError}`);
}

class Inspector {
  #socket: WebSocket; #sequence = 0; #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>(); #closed = false;
  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', event => {
      let response: { id: number; error?: { message: string }; result?: unknown };
      try { response = JSON.parse(String(event.data)); } catch { this.close(); return; }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id); clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error.message)); else pending.resolve(response.result);
    });
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('error', () => this.close());
  }
  static async connect(url: string, timeoutMs: number) {
    const socket = new WebSocket(url);
    const inspector = new Inspector(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed); };
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Node inspector connection failed')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Node inspector connection timed out')); }, timeoutMs);
        socket.addEventListener('open', opened, { once: true }); socket.addEventListener('error', failed, { once: true }); socket.addEventListener('close', failed, { once: true });
      });
      await inspector.send('Runtime.enable');
      return inspector;
    } catch (error) { inspector.close(); throw error; }
  }
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) {
    if (this.#closed) return Promise.reject(new Error('Node inspector is closed'));
    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.#sequence;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Node inspector request timed out: ${method}`)); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.#pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  async evaluate<Result, Argument = undefined>(fn: (electron: typeof Electron, argument: Argument) => Result, argument?: Argument, timeoutMs?: number): Promise<Awaited<Result>> {
    const response = await this.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(require('electron'), ${JSON.stringify(argument) ?? 'undefined'})`,
      includeCommandLineAPI: true, returnByValue: true, awaitPromise: true,
    }, timeoutMs) as Runtime.EvaluateReturnType;
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    if (response.result.unserializableValue) throw new Error('Main-process evaluation returned an unserializable value');
    return response.result.value as Awaited<Result>;
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Node inspector disconnected')); }
    this.#pending.clear(); this.#socket.close();
  }
}

/** Test driver only. verifyIdentity must reject any unexpected app before test mutations. */
export async function launchDesktop({ executable, args = [], cwd, env = process.env, profile, verifyIdentity, timeoutMs = 120_000 }: LaunchOptions) {
  assert(isAbsolute(executable) && isAbsolute(profile), 'Desktop launch requires absolute executable and profile paths');
  assert.equal(typeof verifyIdentity, 'function', 'A running-application identity check is required');
  const nodePort = await reservePort();
  let browserPort;
  try { browserPort = await reservePort(); } catch (error) { await nodePort.release(); throw error; }
  await Promise.all([nodePort.release(), browserPort.release()]);
  const child = spawn(executable, [`--inspect=127.0.0.1:${nodePort.port}`, `--remote-debugging-port=${browserPort.port}`, `--user-data-dir=${profile}`, ...args], {
    cwd, env, shell: false, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: false,
  });
  let exited: ProcessExit | undefined, inspector: Inspector | undefined, browser: Browser | undefined, closed = false;
  const exitPromise = new Promise<ProcessExit>(resolve => {
    child.once('error', error => { exited = { error: error.message }; resolve(exited); });
    child.once('exit', (code, signal) => { exited = { code, signal }; resolve(exited); });
  });
  const waitExit = async (timeout: number) => {
    let timer;
    try { return await Promise.race([exitPromise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop launcher did not exit')), timeout); })]); }
    finally { clearTimeout(timer); }
  };
  const forceClose = async () => {
    inspector?.close();
    if (!exited) { await terminateOwned(child); await waitExit(10_000); }
    await browser?.close();
  };
  try {
    const deadline = Date.now() + timeoutMs;
    const nodeUrl = await discover(nodePort.port, true, deadline, () => exited);
    inspector = await Inspector.connect(nodeUrl, Math.max(1, deadline - Date.now()));
    const identity = await inspector.evaluate(async ({ app }) => {
      await app.whenReady();
      return { pid: process.pid, packaged: app.isPackaged, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
        executable: process.execPath, resources: process.resourcesPath, version: app.getVersion(), electron: process.versions.electron,
        portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE };
    }, undefined, Math.max(1, deadline - Date.now()));
    await verifyIdentity(identity);
    const browserUrl = await discover(browserPort.port, false, deadline, () => exited);
    browser = await chromium.connectOverCDP(browserUrl, { timeout: Math.max(1, deadline - Date.now()) });
    const session = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      assert(processInfo.some(info => info.type === 'browser' && Number(info.id) === identity.pid), 'Chromium endpoint belongs to another process');
    } finally { await session.detach(); }
    return {
      identity,
      evaluate: <Result, Argument = undefined>(fn: (electron: typeof Electron, argument: Argument) => Result, argument?: Argument) => inspector!.evaluate(fn, argument),
      async firstWindow() {
        const context = browser!.contexts()[0];
        assert(context, 'Desktop browser has no default context');
        return context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30_000 });
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await inspector!.evaluate(({ app }) => { setImmediate(() => app.quit()); return true; });
          // Node waits for inspector detachment at shutdown. Do not wait for exit first.
          inspector!.close();
          const exit = await waitExit(30_000);
          assert.equal(exit.code, 0, `Desktop launcher failed: ${JSON.stringify(exit)}`);
          await browser!.close();
        } catch (error) { await forceClose(); throw error; }
      },
    };
  } catch (error) { await forceClose(); throw error; }
}
