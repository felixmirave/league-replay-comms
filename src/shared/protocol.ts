import { z } from 'zod';
import { filterSettingsSchema, type FilterSettings } from './filters';
import type { ReplaySample, SyncStatus, AudioOutputState } from './domain';
import type { Alignment } from '../library/model';
import type { MediaProbe, TrackRange } from './media';
import type { ClockView } from './clock';
import type { SetupView } from './setup';
import type { WorkflowView } from './workflow';

export const userCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open') }),
  z.object({ type: z.literal('open-path'), path: z.string().min(1).max(32768) }),
  z.object({ type: z.literal('select-recording'), id: z.string().min(1).max(256) }),
  z.object({ type: z.literal('workflow'), action: z.enum(['prepare', 'review', 'edit', 'finish-edit', 'change-recording', 'change-track']) }),
  z.object({ type: z.literal('locate-media') }),
  z.object({ type: z.literal('add-media-folder') }),
  z.object({ type: z.literal('retry-save') }),
  z.object({ type: z.literal('preview'), paused: z.boolean() }),
  z.object({ type: z.literal('align'), offsetSeconds: z.number().finite().min(-86_400).max(86_400) }),
  z.object({ type: z.literal('filters'), filters: filterSettingsSchema }),
  z.object({ type: z.literal('mute'), muted: z.boolean() }),
  z.object({ type: z.literal('volume'), volume: z.number().finite().min(0).max(100) }),
  z.object({ type: z.literal('preview-track'), trackId: z.number().int().positive() }),
  z.object({ type: z.literal('track'), trackId: z.number().int().positive() }),
  z.object({ type: z.literal('export-trace'), includePaths: z.boolean().optional() }),
  z.object({ type: z.literal('open-notices') }),
  z.object({ type: z.literal('retry') }),
  z.object({ type: z.literal('analyze-clock') }),
  z.object({ type: z.literal('setup-refresh') }),
  z.object({ type: z.literal('setup-choose-folder') }),
  z.object({ type: z.literal('setup-select'), root: z.string().min(1).max(32768) }),
  z.object({ type: z.literal('setup-open-config'), path: z.string().min(1).max(32768) }),
  z.object({ type: z.literal('setup-enable'), path: z.string().min(1).max(32768) }),
  z.object({ type: z.literal('setup-restore'), path: z.string().min(1).max(32768), backupId: z.uuid() }),
  z.object({ type: z.literal('setup-elevate') }),
]);
export type UserCommand = z.infer<typeof userCommandSchema>;
export interface Track { id: number; title: string; language?: string; selected: boolean; ffIndex?: number; channels?: number; range?: TrackRange }
export interface OpenMedia { name: string; durationSeconds: number; tracks: Track[]; selectedTrackId: number; originSeconds?: number; probe?: MediaProbe; timelineVersion?: number }
export interface LibraryView {
  recordings: { id: string; name: string; path: string; updatedAt: string; pending: boolean }[];
  mediaGeneration: number;
  recordingReady: boolean;
  trackChosen: boolean;
  boundToRuntime?: boolean;
  locating?: boolean;
  alignmentConflict?: boolean;
  recording?: { path: string; hash?: string; progress?: number };
  alignment?: Alignment;
  status?: string;
  error?: string;
  saveError?: string; // Failed writes only; unsaved counts also include pending writes.
  unsavedAlignments?: number;
  unsavedPreferences?: number;
  folders: string[];
  volume: number;
  muted?: boolean;
  needsRecordingChoice?: boolean;
  filters?: FilterSettings;
  filterError?: string;
  warnings: string[];
  missingRecording: boolean;
  timingAnalysis?: 'running' | 'failed';
  clock?: ClockView;
}
export interface ProbeSnapshot {
  startup?: 'loading' | 'ready' | 'failed';
  workflow?: WorkflowView;
  audioOutput?: AudioOutputState;
  sync: SyncStatus;
  replay?: ReplaySample;
  media?: OpenMedia;
  positionSeconds?: number;
  paused: boolean;
  offsetSeconds?: number;
  busy: boolean;
  error?: string;
  connectionError?: string;
  suppressionError?: string;
  library?: LibraryView;
  setup?: SetupView;
}
export interface DesktopInterface {
  openDropped(file: File): Promise<void>;
  command(command: UserCommand): Promise<void>;
  snapshot(): Promise<ProbeSnapshot>;
  subscribe(listener: (snapshot: ProbeSnapshot) => void): () => void;
}
export const initialSnapshot: ProbeSnapshot = { sync: { state: 'preview', reason: 'Open a recording to begin', generation: 0 }, paused: true, busy: false };

export type PlaybackCommand =
  | Extract<UserCommand, { type: 'preview' | 'volume' | 'filters' | 'track' | 'retry' }>
  | { type: 'apply-alignment'; offsetSeconds?: number; replaySessionId?: string }
  | { type: 'load'; path: string; probe?: MediaProbe }
  | { type: 'update-probe'; probe: MediaProbe }
  | { type: 'trace' }
  | { type: 'close' };
export type WorkerRequest = {
  id: number;
  command: PlaybackCommand;
  deadline?: number;
} | { type: 'cancel'; id: number } | { type: 'heartbeat' } | { type: 'power'; state: 'suspend' | 'resume'; sequence: number };
export type WorkerResponse = { type: 'snapshot'; snapshot: ProbeSnapshot } | { type: 'reply'; id: number; error?: string; data?: unknown };
