// shotColors — the one palette shots and their cameras are drawn in (#1708).
//
// A shot's colour is its camera's colour: the film's cameras take the palette in the order they
// first come on screen, so the first shot is always the first colour and a camera that returns in
// a later shot keeps the colour it had (the design's Shot 1 and Shot 4, both on Chase cam, are both
// blue). A camera that films no shot has no colour. The Shots list, the camera frames in the
// viewport and the live preview's caption all read it here, so the three can never disagree.
//
// Derived, never stored: it is read off `shotsOf`, the same rows the Shots list shows, so moving a
// cut recolours whatever it changes and nothing else has to be told.

import type { DagState } from '../core/dag';
import { sceneEndSeconds } from './sceneRange';
import { shotsOf, type Shot } from './shots';

/** The shot palette, in the order cameras take it. The first is the viewport's long-standing
 *  active-camera blue, so a film with one camera looks as it did. */
export const SHOT_COLORS = [
  '#4ea1ff', // blue
  '#e0a940', // amber
  '#a78bfa', // violet
  '#34d399', // green
  '#f472b6', // pink
  '#22d3ee', // cyan
] as const;

/** Each camera that films a shot, with its colour, in the order it first comes on screen. */
export function shotCameraColors(shots: readonly Shot[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const shot of shots) {
    if (shot.cameraId === null || out.has(shot.cameraId)) continue;
    out.set(shot.cameraId, SHOT_COLORS[out.size % SHOT_COLORS.length]);
  }
  return out;
}

/** The colour of the shots `cameraId` films, or null when it films none. */
export function shotColorOfCamera(state: DagState, cameraId: string): string | null {
  return shotCameraColors(shotsOf(state, sceneEndSeconds(state)).shots).get(cameraId) ?? null;
}

/** The shot on screen at `filmSeconds` (the last one at or past the film's end), or null when the
 *  film has no shot. */
export function liveShotAt(state: DagState, filmSeconds: number): Shot | null {
  const shots = shotsOf(state, sceneEndSeconds(state)).shots;
  return shots.find((s) => filmSeconds >= s.start && filmSeconds < s.end) ?? shots.at(-1) ?? null;
}
