import type { FilterSettings } from './filters';
export type AudioOperation =
  | { type: 'load'; path: string; audioIndex: number; channels?: number; origin: number; duration: number }
  | { type: 'seek'; seconds: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'rate'; rate: number }
  | { type: 'volume'; volume: number }
  | { type: 'filters'; filters: FilterSettings }
  | { type: 'observe' | 'close' | 'interrupt' };
export interface BrowserAudioSample { suppressionError?: string; preparation?: { suppressed: boolean; timingsMs: Record<string, number> }; startDelaySeconds?: number; positionSeconds: number; paused: boolean; seeking: boolean; rate: number; uncertaintySeconds: number }
export interface AudioRequest { type: 'audio-request'; id: number; operation: AudioOperation }
export interface AudioReply { type: 'audio-reply'; id: number; data?: unknown; error?: string }

/** Electron may deliver rejected renderer errors as plain objects. */
export function audioErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}
