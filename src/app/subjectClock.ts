// #1594 — which clock a thing is keyed and read on: the scene's, or the playhead's.
//
// Everything in the scene runs on SCENE time (`useTimeStore.seconds`), which the Scene's speed
// slows. A camera does not: its own keys, lens and cuts run on FILM time (the playhead), so it
// keeps moving through a slowed moment (`activeCamera.ts` reads it that way). A key written on a
// camera therefore has to land at film time, or it would play back somewhere else. Equal clocks
// until the scene's speed is changed, so this decides nothing in a scene that never slows.
//
// The Scene's own `timeSpeed` is on film time too: it DEFINES scene time, so it is read at the
// playhead (`sceneClock.ts`) and must be keyed there.

import type { DagState } from '../core/dag/state';
import { isCameraNode } from './cameraNode';
import { useTimeStore } from './stores/timeStore';

const FILM_TYPES = new Set([
  'CameraData',
  'CameraSelect',
  'PerspectiveCamera',
  'OrthographicCamera',
]);

/** True when `id`'s own animation (or its `paramPath`, when given) runs on the playhead: a camera
 *  (either half), a camera cut, or the Scene's speed. */
export function runsOnFilmTime(state: DagState, id: string, paramPath?: string): boolean {
  const node = state.nodes[id];
  if (!node) return false;
  if (node.type === 'Scene') return paramPath === 'timeSpeed';
  return FILM_TYPES.has(node.type) || isCameraNode(state, id);
}

/** The time (seconds and frame) at which `id`'s `paramPath` is keyed and read right now. */
export function clockFor(
  state: DagState,
  id: string,
  paramPath?: string,
): { seconds: number; frame: number } {
  const t = useTimeStore.getState();
  return runsOnFilmTime(state, id, paramPath)
    ? { seconds: t.filmSeconds, frame: t.filmFrame }
    : { seconds: t.seconds, frame: t.frame };
}
