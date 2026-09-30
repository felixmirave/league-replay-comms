import type { ConfigInspection } from '../platform/config';
export interface ConfigBackupView { id: string; path: string; createdAt: string; canRestore: boolean; reason?: string }

export interface ReplayConfigView {
  path: string;
  sha256?: string;
  backups?: ConfigBackupView[];
  inspection: ConfigInspection | { state: 'unreadable' | 'missing'; reason: string };
}
export interface LeagueInstallation { root: string; configs: ReplayConfigView[] }
export interface SetupView {
  searching: boolean;
  installations: LeagueInstallation[];
  selectedRoot?: string;
  warnings: string[];
  error?: string;
  editing?: boolean;
  message?: string;
  needsElevation?: { path: string; action: 'enable' | 'restore' };
}
