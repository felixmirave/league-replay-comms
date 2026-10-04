import { z } from 'zod';

const finite = z.number().finite();
export const playbackSchema = z.object({
  time: finite, speed: finite.nonnegative().max(64), paused: z.boolean(),
  seeking: z.boolean().optional().default(false), length: finite.nonnegative(),
});

export interface ReplaySample {
  sessionId: string;
  timeSeconds: number;
  speed: number;
  paused: boolean;
  seeking: boolean;
  lengthSeconds: number;
  sentAtSeconds: number;
  receivedAtSeconds: number;
}

export interface AudioSample {
  suppressionError?: string;
  /** Delay from starting paused playback to its first audible sample. */
  startDelaySeconds?: number;
  outputRevision?: number;
  positionSeconds: number;
  observedAtSeconds: number;
  uncertaintySeconds: number;
  rate: number;
  paused: boolean;
  seeking: boolean;
}

export interface AudioOutputState {
  revision: number;
  driver?: string;
  configuredDevice?: string;
  devices: { name: string; description: string }[];
  error?: string;
}

export type SyncState = 'waiting' | 'needs-alignment' | 'preview' | 'following' | 'paused' | 'recovering' | 'outside-recording' | 'unsupported-speed' | 'error';
export interface SyncStatus {
  state: SyncState;
  reason: string;
  generation: number;
  targetSeconds?: number;
  errorSeconds?: number;
  rate?: number;
}

export interface Binding {
  replaySessionId: string;
  offsetSeconds: number;
  startSeconds: number;
  endSeconds: number;
}

export type PlaybackAction =
  | { type: 'pause'; paused: boolean }
  | { type: 'rate'; rate: number }
  | { type: 'seek'; targetSeconds: number; generation: number };

export type ControllerEvent =
  | { type: 'replay'; sample: ReplaySample }
  | { type: 'audio'; sample: AudioSample }
  | { type: 'bind'; binding: Binding }
  | { type: 'unbind' }
  | { type: 'mode'; mode: 'follow' | 'preview' }
  | { type: 'seek-complete'; generation: number; sample: AudioSample }
  | { type: 'seek-failed'; generation: number; message: string }
  | { type: 'failure'; message: string }
  | { type: 'retry' }
  | { type: 'reset' }
  | { type: 'tick' };

export const monotonicSeconds = (): number => performance.now() / 1000;
