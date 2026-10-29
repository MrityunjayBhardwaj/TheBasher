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
// set's `roots` (`timeDependentSet.ts`), the same answer the viewport mounts its overlays from.
// For a node outside it, this hook subscribes to nothing and reads the playhead when the field
// renders for any other reason (a selection, an edit), which is the same value it would have
// shown.
//
// REF: issue #1731; src/app/timeDependentSet.ts.

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
  return nodeId != null && timeDependentSetOf(state).roots.has(nodeId);
}

/**
 * The playhead as `nodeId`'s field should see it. Re-renders on a playhead move only when
 * `nodeId`'s own value can change with time; otherwise it is read, not subscribed.
 */
export function usePlayheadFor(nodeId: string | null): Playhead {
  const live = useDagStore((s) => valueMovesWithTime(s.state, nodeId));
  // Every selector runs on every render (hook order); a not-live one returns a constant, so a
  // playhead move changes nothing it returns and nothing re-renders.
  const frame = useTimeStore((s) => (live ? s.frame : -1));
  const seconds = useTimeStore((s) => (live ? s.seconds : -1));
  const normalized = useTimeStore((s) => (live ? s.normalized : -1));
  const filmFrame = useTimeStore((s) => (live ? s.filmFrame : -1));
  const filmSeconds = useTimeStore((s) => (live ? s.filmSeconds : -1));
  if (live) return { frame, seconds, normalized, filmFrame, filmSeconds };
  const now = useTimeStore.getState();
  return {
    frame: now.frame,
    seconds: now.seconds,
    normalized: now.normalized,
    filmFrame: now.filmFrame,
    filmSeconds: now.filmSeconds,
  };
}
