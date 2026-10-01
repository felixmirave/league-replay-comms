import type { LibraryData } from '../src/library/model';
import type { LibraryView } from '../src/shared/protocol';

/** The operations exercised by the volume UI test's bundled real backend. */
export interface VolumeBackend {
  library: {
    updateSettings(value: Partial<LibraryData['settings']>): Promise<void>;
    snapshot(): LibraryData;
  };
  session: {
    snapshot(): LibraryView;
    setVolume(volume: number): Promise<void>;
    retrySave(): Promise<void>;
    settled(): Promise<void>;
    close(): void;
  };
}
export type OpenVolumeBackend = (directory: string, changed: () => void) => Promise<VolumeBackend>;
