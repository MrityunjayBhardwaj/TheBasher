// The last generated motion clip, held only so it can be SAVED (#819).
//
// A generated clip lands in the graph and nowhere else: no bytes, no library
// row, nothing to re-drag onto a second character and nothing that survives a
// reload. The bytes exist for exactly as long as the generate call, and then
// they are gone — so an explicit "save this one" needs somewhere to hold them
// between the generation and the gesture.
//
// 🔑 WHY THIS IS A STORE AND NOT COMPONENT STATE. The offer has to survive the
// panel unmounting — switching to the Outliner tab and back is an ordinary thing
// to do while deciding whether a clip is worth keeping, and losing the ability to
// save because a tab changed would be a rule nobody could predict.
//
// 🔴 WHAT IT DELIBERATELY IS NOT. It is not a history, not a provenance record
// on the graph, and not persistence. It holds ONE clip, it is cleared when that
// clip is saved, and nothing downstream reads it — so nothing in the DAG can
// tell a generated clip from an imported one by looking here, which is the whole
// of phase A1. A second generation replaces the offer, exactly as it replaces
// what a director is looking at.
//
// V8: app-layer. V18 N/A — deliberately NOT persisted: an offer to save bytes
// that no longer exist after a reload would be a button that cannot work.
//
// REF: src/app/asset/generateMotion.ts (records); src/app/asset/saveGeneratedMotion.ts
//      (consumes); src/app/GeneratePanel.tsx (renders the offer); issue #819.

import { create } from 'zustand';

/** A generated clip that has not been saved to the library. */
export interface PendingGeneratedMotion {
  /** The AnimationClip node the generation put in the graph. */
  readonly clipId: string;
  /** What the director asked for — the clip's name, and the save's default. */
  readonly name: string;
  /** The BVH text the generator returned, byte-for-byte. */
  readonly bvh: string;
  /** The checkpoint that produced it. Recorded for the save, not for the graph. */
  readonly model: string;
}

export interface GeneratedMotionState {
  /** The clip on offer, or null when there is nothing unsaved to save. */
  pending: PendingGeneratedMotion | null;
  /** Where the last save landed, so the panel can say so. Cleared by `record`. */
  savedPath: string | null;
  record: (motion: PendingGeneratedMotion) => void;
  markSaved: (path: string) => void;
  clear: () => void;
}

export const useGeneratedMotionStore = create<GeneratedMotionState>((set) => ({
  pending: null,
  savedPath: null,
  // A new generation retires the previous offer AND the previous confirmation:
  // leaving "saved to X" on screen beside a different clip would attach the
  // message to the wrong thing.
  record: (motion) => set({ pending: motion, savedPath: null }),
  markSaved: (path) => set({ pending: null, savedPath: path }),
  clear: () => set({ pending: null, savedPath: null }),
}));
