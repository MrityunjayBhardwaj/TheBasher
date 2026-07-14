// Curve sub-selection — WHICH control point of a Curve is being edited (#322).
//
// Its own store, deliberately. `selectionStore` holds NodeIds and nothing else: every
// consumer (outliner, inspector, gizmo, box-select, the agent) reads it as "the set of
// selected NODES". A control point is not a node — it is an element of an array param,
// identified by (nodeId, index). Widening selectionStore to carry an optional index would
// push that index through every one of those consumers, none of which have any use for it.
//
// The precedent is timelineSelection.ts, which identifies a keyframe by (channelId, time)
// for exactly the same reason: a keyframe has no id either, and the timeline needed a
// sub-selection the node-selection store had no business carrying.
//
// The store is DUMB — it holds a (nodeId, index) pair and validates nothing. Whether that
// pair still names a real point is a question about the DAG, and it is answered in ONE
// place: `resolveCurvePointSelection` (curvePoints.ts). Every reader goes through that
// accessor, so a stale index (the point was deleted, the node was removed, the curve was
// replaced) can never be acted on. Same discipline as the constraint/driver winners: the
// thing everyone reads gets ONE name.
//
// REF: src/app/curvePoints.ts (resolveCurvePointSelection — the validating accessor);
//      src/timeline/timelineSelection.ts (the sub-selection precedent); issue #322.

import { create } from 'zustand';

export interface CurveSelectionStore {
  /** The Curve node whose point is selected; null = no point selection. */
  nodeId: string | null;
  /** Index into that curve's `points` array; null = no point selection. */
  pointIndex: number | null;
  /** Select one control point of one curve. */
  selectPoint: (nodeId: string, pointIndex: number) => void;
  /** Drop the point selection (the object gizmo returns). */
  clear: () => void;
}

export const useCurveSelectionStore = create<CurveSelectionStore>((set) => ({
  nodeId: null,
  pointIndex: null,
  selectPoint: (nodeId, pointIndex) => set({ nodeId, pointIndex }),
  clear: () => set({ nodeId: null, pointIndex: null }),
}));
