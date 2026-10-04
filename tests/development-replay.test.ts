import { describe, expect, it } from 'vitest';
import { developmentReplayArguments } from '../src/main/development-replay';

describe('development Replay API boundary', () => {
  it('keeps packaged applications on the production endpoint even with overrides', () => {
    expect(developmentReplayArguments(true, { COMMS_DEV_REPLAY_PORT: '4444', COMMS_DEV_REPLAY_CA: '/tmp/test.pem' })).toEqual([]);
    expect(developmentReplayArguments(true, { COMMS_DEV_REPLAY_PORT: 'invalid' })).toEqual([]);
  });
  it('requires a complete loopback port and certificate configuration', () => {
    expect(developmentReplayArguments(false, {})).toEqual([]);
    expect(developmentReplayArguments(false, { COMMS_DEV_REPLAY_PORT: '4444', COMMS_DEV_REPLAY_CA: '/tmp/test.pem' })).toEqual(['--development-replay', '4444', '/tmp/test.pem']);
    for (const port of ['0', '65536', 'NaN', '4.5']) expect(() => developmentReplayArguments(false, { COMMS_DEV_REPLAY_PORT: port, COMMS_DEV_REPLAY_CA: '/tmp/test.pem' })).toThrow();
    expect(() => developmentReplayArguments(false, { COMMS_DEV_REPLAY_PORT: '4444' })).toThrow();
    expect(() => developmentReplayArguments(false, { COMMS_DEV_REPLAY_PORT: '4444', COMMS_DEV_REPLAY_CA: 'relative.pem' })).toThrow();
  });
});
