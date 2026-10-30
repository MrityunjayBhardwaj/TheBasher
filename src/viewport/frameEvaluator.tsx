// frameEvaluator — one pass per frame over everything that moves with time (#1730).
//
// WHY THIS EXISTS. After #1728 every animated thing in the viewport ran its own frame loop: each
// keyed object, each keyed light, each camera frustum and light helper sampled itself in its own
// `useFrame`, and any that needed React committed on its own, one synchronous commit per object
// per frame. Nothing ran them in a known order.
//
// The animated renderers no longer own a frame loop. Each registers a TICK with the evaluator
// (`useFrameTick`). Once per frame, before anything else in the frame loop (R3F priority −2), the
// evaluator runs every tick, holders before what they hold (the time-dependent set's `order`). A
// tick writes what it can straight onto three.js objects and may return a React update for what it
// cannot; all of a frame's updates are committed together, in ONE synchronous commit, so they
// cannot be starved by the playhead (#1726) and there is one commit a frame, not one per animated
// object.
//
// #1748 — #1730 also kept a frame table here (each tick's sampled value, a world matrix per node
// asked for by id, the three.js objects drawn as carrying a node's world) for readers to move onto
// in #1731. None did: #1731 met its goals by reading in the frame loop and by one pose per armature
// in `rigIndex`, and a count of every read of the table over 515 frames of scrubbing, playback and
// every kind of selection found none. The table is cut; a reader that wants a node's world asks
// `resolveWorldTransform`, as the gizmo and the camera aim do.
//
// The overlay calls are unchanged: each tick folds exactly what its renderer folded before
// (fold core untouched). What moved is who runs them, in what order, and how they commit.
//
// REF: issues #1730, #1748; docs plan frame-pipeline §2; src/app/timeDependentSet.ts (the order).

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { flushSync, useFrame } from '@react-three/fiber';
import type { DagState } from '../core/dag/state';
import { measureStage } from '../perf/frameProfiler';
import { useDagStore } from '../core/dag/store';
import { timeDependentSetOf } from '../app/timeDependentSet';

/** One animated renderer's per-frame work. Returns a React update to commit, or nothing. */
export type FrameTick = () => (() => void) | void;

interface Entry {
  readonly nodeId: string | null;
  tick: FrameTick;
}

export interface FrameEvaluator {
  register(entry: Entry): () => void;
  run(): void;
}

export function createFrameEvaluator(): FrameEvaluator {
  const entries = new Set<Entry>();
  let ordered: Entry[] | null = null;
  let orderedFor: DagState['nodes'] | null = null;

  const sortEntries = (state: DagState): Entry[] => {
    if (ordered && orderedFor === state.nodes) return ordered;
    const rank = new Map<string, number>();
    timeDependentSetOf(state).order.forEach((id, i) => rank.set(id, i));
    const at = (e: Entry) => (e.nodeId !== null ? (rank.get(e.nodeId) ?? Infinity) : Infinity);
    ordered = [...entries].sort((a, b) => at(a) - at(b));
    orderedFor = state.nodes;
    return ordered;
  };

  return {
    register(entry) {
      entries.add(entry);
      ordered = null;
      return () => {
        entries.delete(entry);
        ordered = null;
      };
    },
    run() {
      const updates: (() => void)[] = [];
      for (const entry of sortEntries(useDagStore.getState().state)) {
        const update = entry.tick();
        if (update) updates.push(update);
      }
      // One synchronous commit for the frame's React updates, not one per object: a deferred
      // update from the frame loop is starved by the playhead's higher-priority ones while the
      // frame is busy (#1726), and a commit per object costs a React pass each.
      if (updates.length > 0) flushSync(() => updates.forEach((u) => u()));
    },
  };
}

const FrameEvaluatorContext = createContext<FrameEvaluator | null>(null);

/** Runs `evaluator` once per frame, first in the frame loop, and provides it to the ticks below. */
export function FrameEvaluatorProvider({
  evaluator,
  children,
}: {
  evaluator: FrameEvaluator;
  children: ReactNode;
}) {
  // `frameEval` in the playback table: this pass's cost must not grow with the static scene (#1730).
  useFrame(() => measureStage('frameEval', () => evaluator.run()), -2);
  return (
    <FrameEvaluatorContext.Provider value={evaluator}>{children}</FrameEvaluatorContext.Provider>
  );
}

/**
 * Run `tick` once per frame from the evaluator, ordered by `nodeId`'s place in the
 * time-dependent set. The newest `tick` is the one run, so it may close over this render's props.
 */
export function useFrameTick(nodeId: string | null, tick: FrameTick): void {
  const evaluator = useContext(FrameEvaluatorContext);
  if (!evaluator)
    throw new Error('an animated renderer is mounted outside <FrameEvaluatorProvider>');
  const latest = useRef(tick);
  latest.current = tick;
  useLayoutEffect(
    () => evaluator.register({ nodeId, tick: () => latest.current() }),
    [evaluator, nodeId],
  );
}
