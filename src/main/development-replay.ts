import { isAbsolute } from 'node:path';

/** Only main decides whether development overrides may reach the sync worker. */
export function developmentReplayArguments(packaged: boolean, environment: NodeJS.ProcessEnv): string[] {
  if (packaged) return [];
  const port = environment.COMMS_DEV_REPLAY_PORT;
  const ca = environment.COMMS_DEV_REPLAY_CA;
  if (port === undefined && ca === undefined) return [];
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !ca || !isAbsolute(ca)) {
    throw new Error('Development Replay API requires a valid COMMS_DEV_REPLAY_PORT and absolute COMMS_DEV_REPLAY_CA');
  }
  return ['--development-replay', port, ca];
}
