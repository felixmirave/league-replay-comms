import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MpvIpc } from '../src/sync/mpv-ipc';

class FakePipe extends Duplex {
  writes: string[] = [];
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) { this.writes.push(chunk.toString()); callback(); }
}

describe('mpv protocol', () => {
  it('correlates out-of-order replies across split frames and interleaved events', async () => {
    const pipe = new FakePipe();
    const ipc = new MpvIpc(pipe);
    const first = ipc.command(['get_property', 'time-pos']);
    const second = ipc.command(['get_property', 'pause']);
    const events: unknown[] = [];
    ipc.on('event', event => events.push(event));
    pipe.push('{"request_id":2,"error":"success","data":true}\n{"event":"playback-');
    pipe.push('restart"}\n{"request_id":1,"error":"success","data":50}\n');
    expect(await first).toBe(50);
    expect(await second).toBe(true);
    expect(events).toEqual([{ event: 'playback-restart' }]);
    ipc.close();
  });
  it('fails pending work on disconnect instead of leaving playback promises hanging', async () => {
    const ipc = new MpvIpc(new FakePipe());
    const pending = ipc.command(['seek', 100, 'absolute+exact']);
    const assertion = expect(pending).rejects.toThrow('closed');
    ipc.close();
    await assertion;
    await expect(ipc.command(['get_property', 'pause'])).rejects.toThrow('disconnected');
  });
  it('bounds stalled commands with a deadline', async () => {
    const ipc = new MpvIpc(new FakePipe(), 10);
    await expect(ipc.command(['get_property', 'time-pos'])).rejects.toThrow('timed out');
    ipc.close();
  });
});
