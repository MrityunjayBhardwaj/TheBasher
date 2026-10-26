// #1641 / #1688 — where a key sits on the dopesheet's ruler. The ruler counts the playhead (film
// time). A key is stored on the clock its channel plays on (`clockOf`): a camera's, a cut's, the
// Scene speed's and a Film rig's on the playhead, everything else on scene time. A scene-time key
// is drawn at the first playhead time whose scene time reaches it — where it is first on screen —
// and a key dragged along the ruler is stored back on its own clock. Identity in a scene that
// never slows, so nothing moves until the Scene's speed is changed.

import type { DagState } from '../core/dag/state';
import { clockOf } from '../app/subjectClock';
import type { TimeMap } from '../app/stores/timeStore';
import type { ChannelRow } from './channelRow';

export interface KeyRuler {
  /** A stored key time → its place on the ruler. */
  toRuler(time: number): number;
  /** A place on the ruler → the time a key put there is stored at. */
  fromRuler(ruler: number): number;
}

const SAME: KeyRuler = { toRuler: (t) => t, fromRuler: (t) => t };

/** The ruler mapping for one row: identity for a row on the playhead's clock. */
export function keyRulerFor(state: DagState, row: ChannelRow, timeMap: TimeMap): KeyRuler {
  const target = row.targetId;
  if (!target || clockOf(state, target, row.paramPath) === 'film') return SAME;
  return { toRuler: (t) => timeMap.filmAt(t), fromRuler: (t) => timeMap.sceneAt(t) };
}

/** The identity mapping, for rows nothing has mapped (fixtures, a scene that never slows). */
export const IDENTITY_KEY_RULER = SAME;
