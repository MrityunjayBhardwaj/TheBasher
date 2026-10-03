// #1287 — the scene's End is the playhead's playable range in 3D.
//
// The time store holds ONE playable range, which every timeline and the clock read. Outside
// Video mode it is the scene's End (`sceneRange.ts`), so changing End — from the Timebar, an
// undo, the agent, or loading another project — moves where playback loops. Video mode sizes
// the range to its composition while it is the active space and restores the previous value on
// exit; React runs that restore before this effect (all cleanups precede all setups in a
// commit), so on the way back to 3D the scene's End wins.

import { useEffect } from 'react';
import { useDagStore } from '../core/dag/store';
import { sceneEndSeconds } from './sceneRange';
import { useEditorStore } from './stores/editorStore';
import { useTimeStore } from './stores/timeStore';

export function SceneRangeSync() {
  const space = useEditorStore((s) => s.space);
  const end = useDagStore((s) => sceneEndSeconds(s.state));
  useEffect(() => {
    if (space === 'video') return;
    useTimeStore.getState().setRange(end, end);
  }, [space, end]);
  return null;
}
