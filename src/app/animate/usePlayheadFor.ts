// usePlayheadFor — the playhead, for a field that shows one node's value: subscribed only when
// that value can change with time (#1731).
//
// WHY THIS EXISTS. Every inspector field subscribed to the playhead and resolved its node's
// evaluated value on every frame of playback, whatever the node. Measured on the real GPU (Apple
// M4 Pro, 800 objects, a static sphere nested under a keyed Group selected): about 8 of the
// 11.7 ms of our own per-frame work was the inspector, re-evaluating and re-hashing the selected
// node's subtree per field per frame, to display numbers that do not move. The sphere's WORLD
// moves with its Group; its own position, rotation and scale (what the inspector shows) do not.
//
// A node's own value changes with time only through what targets it: a keyed channel, a strip, a
// bound driver (on it or on its data lane), or an active constraint. That is the time-dependent
// set's `channelDriven` and `constrained` (`timeDependentSet.ts`), the same answer the viewport
// mounts its overlays from. Not `posed`: a pose moves an armature's bones, not the Object's own
// position, rotation and scale, which is what its fields show (measured: a posed armature
// selected in Pose mode re-resolved its transform rows every frame, 1.6 ms).
//
// For a node whose value cannot move, this hook subscribes to nothing and hands back a playhead
// that stays put while the node does (taken when the field first asks for it), so a field whose
// parent re-renders every frame (the Scene speed field under the Timebar) keeps its memo instead
// of re-resolving at each new time. Any time gives that node the same value.
//
// REF: issue #1731; src/app/timeDependentSet.ts.

import { useRef } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useTimeStore } from '../stores/timeStore';
import { timeDependentSetOf } from '../timeDependentSet';

export interface Playhead {
  readonly frame: number;
  readonly seconds: number;
  readonly normalized: number;
  readonly filmFrame: number;
  readonly filmSeconds: number;
}

/** True when `nodeId`'s own evaluated value can change with time. */
export function valueMovesWithTime(
  state: Parameters<typeof timeDependentSetOf>[0],
  nodeId: string | null,
): boolean {
  if (nodeId == null) return false;
  const set = timeDependentSetOf(state);
  return set.channelDriven.has(nodeId) || set.constrained.has(nodeId);
}

const read = (): Playhead => {
  const now = useTimeStore.getState();
  return {
    frame: now.frame,
    seconds: now.seconds,
    normalized: now.normalized,
    filmFrame: now.filmFrame,
    filmSeconds: now.filmSeconds,
  };
};

/**
 * The playhead as a field showing `nodeIds`' values should see it. Re-renders on a playhead move
 * only when one of them can change with time; otherwise it is read once and held.
 */
export function usePlayheadFor(...nodeIds: (string | null)[]): Playhead {
  const live = useDagStore((s) => nodeIds.some((id) => valueMovesWithTime(s.state, id)));
  return usePlayheadWhen(live, nodeIds.join('|'));
}

/**
 * The playhead, subscribed while `live`; otherwise read once and held until `key` changes. For a
 * field whose own rule for "can this move?" is not `valueMovesWithTime` of its node ids.
 */
export function usePlayheadWhen(live: boolean, key: string): Playhead {
  // Every selector runs on every render (hook order); a not-live one returns a constant, so a
  // playhead move changes nothing it returns and nothing re-renders.
  const frame = useTimeStore((s) => (live ? s.frame : -1));
  const seconds = useTimeStore((s) => (live ? s.seconds : -1));
  const normalized = useTimeStore((s) => (live ? s.normalized : -1));
  const filmFrame = useTimeStore((s) => (live ? s.filmFrame : -1));
  const filmSeconds = useTimeStore((s) => (live ? s.filmSeconds : -1));
  const held = useRef<{ key: string; at: Playhead } | null>(null);
  if (live) {
    held.current = null;
    return { frame, seconds, normalized, filmFrame, filmSeconds };
  }
  if (held.current?.key !== key) held.current = { key, at: read() };
  return held.current.at;
}
