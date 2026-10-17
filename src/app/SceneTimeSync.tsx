// #1594 — installs the rendered Scene's clock (its `timeSpeed`) as the time store's film → scene
// map, so every reader of `useTimeStore.seconds` follows the scene's speed without knowing it.
//
// The clock is rebuilt when the graph changes (`sceneClockOf` memoises on the nodes record) and
// scene time is re-derived at the current playhead, so keying a new speed moves what is on
// screen at once. Video mode times a composition, not the scene, so it runs on the identity.

import { useEffect } from 'react';
import { useDagStore } from '../core/dag/store';
import { sceneClockOf } from './sceneClock';
import { useEditorStore } from './stores/editorStore';
import { useTimeStore } from './stores/timeStore';

export function SceneTimeSync() {
  const space = useEditorStore((s) => s.space);
  const clock = useDagStore((s) => sceneClockOf(s.state));
  useEffect(() => {
    useTimeStore.getState().setTimeMap(space === 'video' || clock.identity ? null : clock);
  }, [space, clock]);
  return null;
}
