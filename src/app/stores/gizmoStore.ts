// Gizmo store — UI projection of TransformControls drag state.
//
// Used to disable OrbitControls while a TransformControls handle is being
// dragged. Without this, the orbit camera fights the gizmo: orbit drag
// rotates while gizmo drag translates, producing both at once.
//
// File-rooted V8: this store is mutated from src/app/Gizmo.tsx (the
// dispatch surface) and read by src/viewport/Viewport.tsx (read-only).

import { create } from 'zustand';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** Transform orientation (Blender orientation.rst). In Object Mode the
 *  meaningful pair is Global (world axes) and Local (the object's own axes;
 *  Normal == Local in object mode). Maps to three's TransformControls `space`
 *  prop: 'global' → 'world', 'local' → 'local'. */
export type GizmoOrientation = 'global' | 'local';

export interface GizmoStore {
  dragging: boolean;
  mode: GizmoMode;
  /** Whether the gizmo handles align to world axes ('global') or the object's
   *  own axes ('local'). UI projection only — never the DAG. */
  orientation: GizmoOrientation;
  setDragging: (dragging: boolean) => void;
  setMode: (mode: GizmoMode) => void;
  setOrientation: (orientation: GizmoOrientation) => void;
  toggleOrientation: () => void;
}

export const useGizmoStore = create<GizmoStore>((set, get) => ({
  dragging: false,
  mode: 'translate',
  orientation: 'global',
  setDragging: (dragging) => set({ dragging }),
  setMode: (mode) => set({ mode }),
  setOrientation: (orientation) => set({ orientation }),
  toggleOrientation: () =>
    set({ orientation: get().orientation === 'global' ? 'local' : 'global' }),
}));
