// My-Imports freshness signal — Phase 7.9 Wave A (issue #110).
//
// A minimal counter store. Bumped by the shared glTF import core
// (`importGltf.ts`) on every successful import; the AssetLibrary's
// "My Imports" section (LeftSidebar "Assets" tab — UX backlog #6)
// consumes the counter as a useEffect dep so it re-enumerates
// `user-imports/` immediately, without depending on the tab being
// re-opened. This converts the post-import freshness from
// "best-effort on next mount" into a NON-optional guarantee
// (CONTEXT pre-mortem #4, checker C3).
//
// V8: app-layer projection. V18 N/A: no persistence — OPFS is the
// source of truth, the counter only triggers re-reads.
//
// REF: phase 7.9 PLAN Task 2 + Task 9; CONTEXT D-03; issue #110.

import { create } from 'zustand';

export interface ImportRefreshState {
  /** Monotonically increasing counter. Each successful import increments. */
  tick: number;
  /** Increment the counter. Called by importGltf.ts after dispatchAtomic. */
  bump: () => void;
}

export const useImportRefreshStore = create<ImportRefreshState>((set) => ({
  tick: 0,
  bump: () => set((s) => ({ tick: s.tick + 1 })),
}));
