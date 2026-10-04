export type WorkflowState = 'starting' | 'checking' | 'setup.folder' | 'setup.installation' | 'setup.enable' | 'setup.permission' | 'setup.editing' | 'setup.repair'
  | 'replay.wait' | 'recording.choose' | 'recording.opening' | 'recording.identifying' | 'recording.locate' | 'recording.track' | 'recording.timing' | 'recording.timing-error'
  | 'alignment.analyzing' | 'alignment.manual' | 'ready.offline' | 'listening' | 'audio.error' | 'application.error';
export type WorkflowIntent = 'prepare' | 'review' | 'edit' | 'finish-edit' | 'change-recording' | 'change-track';
export interface WorkflowView {
  state: WorkflowState;
  revision: number;
  editorKey: number;
  canReturn: boolean;
  primary?: string;
}
