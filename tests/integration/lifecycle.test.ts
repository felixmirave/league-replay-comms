import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { MpvIpc } from '../../src/sync/mpv-ipc';

describe.skipIf(!process.env.COMMS_TEST_MPV)('owned media process', () => {
  it('exits when controller heartbeats stop even without a quit command', async () => {
    const name = `comms-lifecycle-${randomUUID()}`;
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
    const child = spawn(process.env.COMMS_TEST_MPV!, ['--no-config', '--idle=yes', '--terminal=no', '--ao=null',
      `--input-ipc-server=${pipe}`, `--script=${resolve('resources/scripts/heartbeat.lua')}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', data => { stderr += String(data); });
    let ipc: MpvIpc | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const exit = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolveExit(code));
    });
    try {
      const startupDeadline = performance.now() + 15_000;
      while (!ipc && performance.now() < startupDeadline) {
        if (child.exitCode !== null) throw new Error(`Test media process exited (${child.exitCode}): ${stderr}`);
        try {
          const socket = await new Promise<ReturnType<typeof createConnection>>((resolveSocket, reject) => {
            const socket = createConnection(pipe);
            socket.once('error', reject);
            socket.once('connect', () => { socket.removeListener('error', reject); resolveSocket(socket); });
          });
          ipc = new MpvIpc(socket);
        } catch { await delay(20); }
      }
      if (!ipc) throw new Error(`Test media process did not start: ${stderr}`);
      await ipc.command(['script-message', 'comms-heartbeat']);
      ipc.close(); // Simulates loss of the controlling process, without quitting mpv.
      const code = await Promise.race([exit, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Orphaned media process kept running')), 3500);
      })]);
      expect(code).toBe(0);
    } finally {
      clearTimeout(deadline);
      ipc?.close();
      child.kill();
      if (process.platform !== 'win32') await rm(pipe, { force: true });
    }
  }, 20_000);
});
