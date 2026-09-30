export type WorkflowState = 'checking' | 'setup.folder' | 'setup.installation' | 'setup.enable' | 'setup.permission' | 'setup.editing' | 'setup.repair'
  | 'replay.wait' | 'recording.choose' | 'recording.opening' | 'recording.identifying' | 'recording.locate' | 'recording.track' | 'recording.timing' | 'recording.timing-error'
  | 'alignment.analyzing' | 'alignment.crop' | 'alignment.manual' | 'ready' | 'ready.offline' | 'listening' | 'audio.error' | 'application.error';
export type WorkflowIntent = 'prepare' | 'review' | 'edit' | 'cancel-edit' | 'change-recording' | 'change-track';
export interface WorkflowView {
  state: WorkflowState;
  revision: number;
  editorKey: number;
  suggestedOffsetSeconds?: number;
  canCancelEdit: boolean;
  canReturn: boolean;
  primary?: string;
}
