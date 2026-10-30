// frameEvaluator — one pass per frame over everything that moves with time, and the table it
// leaves behind (#1730).
//
// WHY THIS EXISTS. After #1728 every animated thing in the viewport ran its own frame loop: each
// keyed object, each keyed light, each camera frustum and light helper sampled itself in its own
// `useFrame`, and any that needed React committed on its own, one synchronous commit per object
// per frame. Nothing ran them in a known order, nothing kept what they computed, and every reader
// that wanted "where is this node now" (the gizmo, the camera aim, a bone-parented child) worked
// it out again for itself.
//
// Blender evaluates what depends on time once per frame into evaluated copies and draws from
// those; the draw code never re-derives a transform. This is the same shape, at the size this
// step takes:
//
//   - The animated renderers no longer own a frame loop. Each registers a TICK with the
//     evaluator (`useFrameTick`). Once per frame, before anything else in the frame loop
//     (R3F priority −2), the evaluator runs every tick, holders before what they hold (the
//     time-dependent set's `order`). A tick writes what it can straight onto three.js objects
//     and may return a React update for what it cannot; all of a frame's updates are committed
//     together, in ONE synchronous commit, so they cannot be starved by the playhead (#1726) and
//     there is one commit a frame, not one per animated object.
//   - The FRAME TABLE (`frameTableOf`) is this frame's answers: each tick's sampled value, and a
//     node's world matrix asked for by id, worked out at most once per frame for a node that
//     depends on time and once per graph for one that does not. Readers move onto it in the next
//     step (#1731); today the parity seam reads it.
//   - The OBJECT REGISTRY: the three.js object that carries a node's world, registered by the
//     renderer that draws it, so the table can be checked against what is actually drawn.
//
// The overlay calls are unchanged: each tick folds exactly what its renderer folded before
// (fold core untouched). What moved is who runs them, in what order, and how they commit.
//
// REF: issue #1730; docs plan frame-pipeline §2–§3; src/app/timeDependentSet.ts (the order).

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { flushSync, useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import type { DagState } from '../core/dag/state';
import { measureStage } from '../perf/frameProfiler';
import { resolveWorldTransform } from '../app/resolveWorldTransform';
import { useDagStore } from '../core/dag/store';
import { useTransientEditStore } from '../app/stores/transientEditStore';
import { ctxOnClockOf, liveCtx } from '../app/subjectClock';
import { timeDependentSetOf } from '../app/timeDependentSet';
import { uiEvaluatorCache } from '../app/uiEvaluatorCache';

/** One animated renderer's per-frame work. Returns a React update to commit, or nothing. */
export type FrameTick = () => (() => void) | void;

interface Entry {
  readonly nodeId: string | null;
  tick: FrameTick;
}

/** This frame's answers. */
export interface FrameTable {
  /** Frames evaluated so far; a reader can tell a stale answer by it. */
  readonly frame: number;
  /** React updates the evaluator has committed so far, over all frames. With nothing edited and
   *  only transforms keyed, this stays put during playback: a transform is written, not
   *  rendered. */
  readonly updates: number;
  /** The sampled value a node's renderer drew this frame, by node id. */
  readonly values: ReadonlyMap<string, unknown>;
  /** The node's world matrix (column-major, 16 numbers) on its own clock at the live playhead,
   *  as `resolveWorldTransform` answers it; null where that has no answer. */
  world(nodeId: string): readonly number[] | null;
  /** The three.js objects drawn as carrying `nodeId`'s world. */
  drawn(nodeId: string): ReadonlySet<THREE.Object3D>;
}

export interface FrameEvaluator {
  register(entry: Entry): () => void;
  registerDrawn(nodeId: string, object: THREE.Object3D): () => void;
  /** Record a node's sampled value for this frame (a tick calls this). */
  record(nodeId: string, value: unknown): void;
  run(): void;
  readonly table: FrameTable;
}

const NONE: ReadonlySet<THREE.Object3D> = new Set();

export function createFrameEvaluator(): FrameEvaluator {
  const entries = new Set<Entry>();
  let ordered: Entry[] | null = null;
  let orderedFor: DagState['nodes'] | null = null;
  const drawn = new Map<string, Set<THREE.Object3D>>();
  const values = new Map<string, unknown>();
  let frame = 0;
  let updateCount = 0;
  // A node that depends on time: its world for this frame. One that does not: kept per node table
  // and per held-edit set (a held drag moves a static node too).
  const worldNow = new Map<string, readonly number[] | null>();
  const worldKept = new Map<string, readonly number[] | null>();
  let keptFor: { nodes: DagState['nodes']; edits: unknown } | null = null;

  const sortEntries = (state: DagState): Entry[] => {
    if (ordered && orderedFor === state.nodes) return ordered;
    const rank = new Map<string, number>();
    timeDependentSetOf(state).order.forEach((id, i) => rank.set(id, i));
    const at = (e: Entry) => (e.nodeId !== null ? (rank.get(e.nodeId) ?? Infinity) : Infinity);
    ordered = [...entries].sort((a, b) => at(a) - at(b));
    orderedFor = state.nodes;
    return ordered;
  };

  const table: FrameTable = {
    get frame() {
      return frame;
    },
    get updates() {
      return updateCount;
    },
    values,
    world(nodeId) {
      const state = useDagStore.getState().state;
      const edits = useTransientEditStore.getState().edits;
      if (!keptFor || keptFor.nodes !== state.nodes || keptFor.edits !== edits) {
        worldKept.clear();
        keptFor = { nodes: state.nodes, edits };
      }
      const live = timeDependentSetOf(state).has(nodeId);
      const memo = live ? worldNow : worldKept;
      if (memo.has(nodeId)) return memo.get(nodeId)!;
      const ctx = ctxOnClockOf(state, nodeId, liveCtx());
      let m: readonly number[] | null = null;
      try {
        m = resolveWorldTransform(state, nodeId, ctx, uiEvaluatorCache)?.matrix ?? null;
      } catch {
        m = null;
      }
      memo.set(nodeId, m);
      return m;
    },
    drawn: (nodeId) => drawn.get(nodeId) ?? NONE,
  };

  return {
    table,
    register(entry) {
      entries.add(entry);
      ordered = null;
      return () => {
        entries.delete(entry);
        ordered = null;
      };
    },
    registerDrawn(nodeId, object) {
      let set = drawn.get(nodeId);
      if (!set) drawn.set(nodeId, (set = new Set()));
      set.add(object);
      return () => {
        set!.delete(object);
        if (set!.size === 0 && drawn.get(nodeId) === set) drawn.delete(nodeId);
      };
    },
    record(nodeId, value) {
      values.set(nodeId, value);
    },
    run() {
      frame++;
      worldNow.clear();
      const updates: (() => void)[] = [];
      for (const entry of sortEntries(useDagStore.getState().state)) {
        const update = entry.tick();
        if (update) updates.push(update);
      }
      // One synchronous commit for the frame's React updates, not one per object: a deferred
      // update from the frame loop is starved by the playhead's higher-priority ones while the
      // frame is busy (#1726), and a commit per object costs a React pass each.
      updateCount += updates.length;
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
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __basher_frame_table?: FrameTable };
    w.__basher_frame_table = evaluator.table;
    return () => {
      if (w.__basher_frame_table === evaluator.table) delete w.__basher_frame_table;
    };
  }, [evaluator]);
  return (
    <FrameEvaluatorContext.Provider value={evaluator}>{children}</FrameEvaluatorContext.Provider>
  );
}

/** The evaluator this renderer runs under. */
export function useFrameEvaluator(): FrameEvaluator {
  const evaluator = useContext(FrameEvaluatorContext);
  if (!evaluator)
    throw new Error('an animated renderer is mounted outside <FrameEvaluatorProvider>');
  return evaluator;
}

/**
 * Run `tick` once per frame from the evaluator, ordered by `nodeId`'s place in the
 * time-dependent set. The newest `tick` is the one run, so it may close over this render's props.
 */
export function useFrameTick(nodeId: string | null, tick: FrameTick): void {
  const evaluator = useFrameEvaluator();
  const latest = useRef(tick);
  latest.current = tick;
  useLayoutEffect(
    () => evaluator.register({ nodeId, tick: () => latest.current() }),
    [evaluator, nodeId],
  );
}
