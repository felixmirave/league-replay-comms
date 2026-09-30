import { useRef, useState } from 'react';
import type { DesktopInterface } from '../shared/protocol';

export function useVolume(savedVolume: number, send: DesktopInterface['command'], reportError: (message: string) => void) {
  const [draft, setDraft] = useState<number>();
  const revision = useRef(0);
  const changeVolume = async (volume: number) => {
    const edit = ++revision.current;
    // Both sliders share immediate input feedback. Clock snapshots and replies
    // to older edits must not restore a stale value while the latest edit saves.
    setDraft(volume);
    reportError('');
    try { await send({ type: 'volume', volume }); }
    catch (error) { if (edit === revision.current) reportError(error instanceof Error ? error.message : String(error)); }
    finally {
      // The main process publishes the retained preference before replying,
      // including when playback or saving fails. Resume following it when idle.
      if (edit === revision.current) setDraft(undefined);
    }
  };
  return [draft ?? savedVolume, changeVolume] as const;
}
