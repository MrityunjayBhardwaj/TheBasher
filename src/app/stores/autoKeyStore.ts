// Auto-Key store — the global "record" mode flag (Blender Auto-Key parity,
// D-02 / D-06). When enabled, an inspector param edit auto-inserts a keyframe
// at the current playhead through the SAME Wave A Mutator seam a diamond click
// uses (it is NOT a second DAG path — RESEARCH Boundary 5).
//
// Discipline (mirrors timeStore.ts:8-11 EXACTLY): this is a UI MODE projection,
// NOT the DAG and NOT the Op log. Toggling Auto-Key never dispatches an Op and
// never mutates the DAG store. Like the playhead and timelineDrawerOpen, it
// belongs to the editor session, not the saved project.
//
// Persistence: deliberately NONE. Auto-Key is session-scoped exactly like the
// playhead (timeStore) and the camera pose (viewportStore header). Persisting
// it would AMPLIFY the footgun the D-02 pre-mortem names — a director who left
// record on yesterday must not have it silently re-arm on reload and key every
// edit by accident. Default `false` every session. (No localStorage read here
// means H26/V18 do not apply — there is no module-load Storage surface.)
//
// File-rooted V8: lives in src/app/stores/ with the other UI projection
// stores; read by the Timebar indicator (D2) + NPanel commit handlers (D4);
// the toggle is the only writer.
//
// REF: timeStore.ts:8-11 (UI-mode-not-DAG discipline this mirrors);
//      viewportStore.ts:5-7 (session-not-persisted projection precedent);
//      docs/UI-SPEC.md §1 D-02 / D-06; THESIS.md §767/§123.

import { create } from 'zustand';

export interface AutoKeyStore {
  /** True when Auto-Key (record) mode is armed. Default false every session. */
  enabled: boolean;
  /** The ONLY writer entry point — flips `enabled`. */
  toggle(): void;
}

export const useAutoKeyStore = create<AutoKeyStore>((set, get) => ({
  enabled: false,
  toggle: () => set({ enabled: !get().enabled }),
}));
