import { ReviewLibrary } from '../../src/library/library';
import { ReviewSession } from '../../src/main/review-session';
import type { ProbeSnapshot } from '../../src/shared/protocol';
import type { VolumeBackend } from '../volume-backend-types';

export async function openVolumeBackend(directory: string, changed: () => void): Promise<VolumeBackend> {
  const library = await ReviewLibrary.open(directory);
  const state: ProbeSnapshot = { sync: { state: 'preview', reason: 'Volume fixture', generation: 0 }, paused: true, busy: false };
  const session = new ReviewSession(library, { identify: async () => { throw new Error('Unexpected identification in volume test'); } },
    { snapshot: () => state, send: async () => state }, changed);
  return { library, session };
}
