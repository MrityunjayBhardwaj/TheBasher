// nlaSelectionStore — which Strip OR Track is selected in the NLA lane view
// (epic #283 Phase 5; UI-SPEC §1.5/§2.8). The videoSelectionStore clone:
// selection lifted to a tiny shared UI store so the lane pane (highlight) and
// the strip inspector (fields) read the SAME id — one source of truth, two
// surfaces.
//
// Why a LOCAL store, not the global useSelectionStore: Strips/Tracks are
// edge-less sidecar nodes with no outliner presence (Strip.ts:9-11), NPanel
// would render an empty shell for them, and hijacking global selection would
// detach the gizmo/3D selection every time a director clicks a strip
// (UI-SPEC §1.5, the "selected an evaluation-wrapper → empty panel" class).
// The NLA pane READS global selection (add-strip target default) but never
// writes it.
//
// Single-slot, strip XOR track: one inspector, one subject — selecting a
// strip clears the track selection and vice versa. UI projection only (V8):
// holds node ids, never node data — a stale id (strip deleted) degrades to
// "no selection" at the consumer, exactly like videoSelectionStore.
//
// In-memory (not persisted): a Strip/Track node id is meaningless across a
// project switch / reload.
//
// REF: .planning/phases/nla-5-lane-ui/UI-SPEC.md §1.5/§3.2; sibling:
//      src/app/video/videoSelectionStore.ts:23-34; issue #283.

import { create } from 'zustand';
import type { NodeId } from '../core/dag/types';

export interface NlaSelectionStore {
  /** The selected Strip node in the NLA lane view, or null. */
  selectedStripId: NodeId | null;
  /** The selected Track node in the NLA lane view, or null. */
  selectedTrackId: NodeId | null;
  /** Select a strip (clears any track selection — strip XOR track). */
  selectStrip(id: NodeId | null): void;
  /** Select a track (clears any strip selection — strip XOR track). */
  selectTrack(id: NodeId | null): void;
  /** Clear both selections (Esc). */
  clear(): void;
}

export const useNlaSelectionStore = create<NlaSelectionStore>((set) => ({
  selectedStripId: null,
  selectedTrackId: null,
  selectStrip(id) {
    set({ selectedStripId: id, selectedTrackId: null });
  },
  selectTrack(id) {
    set({ selectedStripId: null, selectedTrackId: id });
  },
  clear() {
    set({ selectedStripId: null, selectedTrackId: null });
  },
}));
