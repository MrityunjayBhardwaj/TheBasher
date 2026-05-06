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

export interface GizmoStore {
  dragging: boolean;
  mode: GizmoMode;
  setDragging: (dragging: boolean) => void;
  setMode: (mode: GizmoMode) => void;
}

export const useGizmoStore = create<GizmoStore>((set) => ({
  dragging: false,
  mode: 'translate',
  setDragging: (dragging) => set({ dragging }),
  setMode: (mode) => set({ mode }),
}));
