// Light Brush tool state (epic #201, slice #207). A viewport MODAL: while active, a
// click on a scene mesh paints the SELECTED rig light onto the rig sphere via the
// brush placement core (the §7.4 gesture), instead of selecting the mesh. The mode
// chooses the brush direction: 'reflect' paints a specular HIGHLIGHT at the click,
// 'normal' paints a straight-on key.
//
// File-rooted V8 UI projection (V1 — the DAG never mutates from tool state). NOT
// persisted: a transient tool mode, like the gizmo's drag flag (gizmoStore) — it
// resets to off on reload by design (you don't want to boot mid-brush).
//
// REF: src/app/resolveLightBrushPlacement.ts; src/app/lightBrush.ts (the op
//      builder this gates); docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.4.

import { create } from 'zustand';

export type LightBrushMode = 'reflect' | 'normal';

export interface LightBrushStore {
  active: boolean;
  mode: LightBrushMode;
  setActive: (active: boolean) => void;
  toggleActive: () => void;
  setMode: (mode: LightBrushMode) => void;
}

export const useLightBrushStore = create<LightBrushStore>((set) => ({
  active: false,
  mode: 'reflect',
  setActive: (active) => set({ active }),
  toggleActive: () => set((s) => ({ active: !s.active })),
  setMode: (mode) => set({ mode }),
}));
