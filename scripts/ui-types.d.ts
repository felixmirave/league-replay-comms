import type { DesktopInterface, ProbeSnapshot, UserCommand } from '../src/shared/protocol';
import type { MessageBoxOptions, MessageBoxReturnValue, shell } from 'electron';

interface PendingCommand { command: UserCommand; resolve: () => void; reject: (error: Error) => void }
interface VolumeFixture {
  state: ProbeSnapshot & Required<Pick<ProbeSnapshot, 'library' | 'replay' | 'workflow'>>;
  calls: PendingCommand[];
  listener: (state: ProbeSnapshot) => void;
  publish: (volume?: number) => void;
  input?: HTMLInputElement;
  inputValue?: string;
}
interface TimingFixture extends Omit<VolumeFixture, 'state'> {
  state: VolumeFixture['state'] & Required<Pick<ProbeSnapshot, 'media'>>;
}
declare global {
  interface Window {
    review: DesktopInterface;
    volumeTest: VolumeFixture;
    timingTest: TimingFixture;
    volumeLayout?: { frames: { top: number; warning: boolean }[]; raf: number };
    persistVolume: (command: UserCommand) => Promise<void>;
  }
  var commsOriginalOpenPath: typeof shell.openPath | undefined;
  var commsOpenedPaths: string[] | undefined;
  var packagedNoticePaths: string[];
  var originalNoticeOpen: typeof shell.openPath;
  var exitDialogOptions: MessageBoxOptions | undefined;
  var answerExitDialog: (answer: MessageBoxReturnValue) => void;
  var startupProbe: { entered: boolean; visible: boolean; release: () => void };
}
