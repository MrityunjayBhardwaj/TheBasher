// editorStore — UI projection for the active editor space (which view
// fills the center pane of the layout) and the active tool (which
// pointer interaction the viewport is set up to perform).
//
// Blender-style space toggling: 3D Viewport ↔ UV Editor (later: Timeline,
// Graph editor, Outliner). The 3D Canvas does NOT unmount when the user
// switches space — Layout flips slot visibility via display:none,
// mirroring K1 step 6's discipline (Canvas mounts ONCE; mode/space
// switches must not drop GPU state).
//
// activeTool — added P6 W2 per UI-SPEC §5.4 / §6.2. The four primary
// tools are Select / Translate / Rotate / Scale. Translate / Rotate /
// Scale also drive `gizmoStore.mode` so the existing TransformControls
// wiring keeps working without a parallel control path. `select` is the
// "no gizmo, just pick" mode: gizmoStore.mode is left untouched (the
// previous transform mode persists and is what re-engages when the user
// switches back). The other ToolRail icons (Add / Light / Camera /
// Group) are side-effect actions, not modes — they do NOT call
// setActiveTool.
//
// File-rooted V8: this store is a UI projection, mutated only by
// src/app/* surfaces. Never touches the DAG.
//
// REF: THESIS.md §11 (viewport), §17 (mode hierarchy — sister concept);
// docs/UI-SPEC.md §5.4, §6.2.

import { create } from 'zustand';
import { useGizmoStore } from './gizmoStore';

export type SpaceType = 'view3d' | 'uv';
export type ActiveTool = 'select' | 'translate' | 'rotate' | 'scale';

export interface EditorStore {
  /** Which editor occupies the center pane right now. */
  space: SpaceType;
  setSpace(space: SpaceType): void;
  /** Cycle to the next space — wired to Tab in KeyboardShortcuts. */
  toggleSpace(): void;
  /** Which tool the viewport pointer is currently set to. */
  activeTool: ActiveTool;
  setActiveTool(tool: ActiveTool): void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  space: 'view3d',
  activeTool: 'select',
  setSpace(space) {
    set({ space });
  },
  toggleSpace() {
    set({ space: get().space === 'view3d' ? 'uv' : 'view3d' });
  },
  setActiveTool(tool) {
    set({ activeTool: tool });
    if (tool === 'translate' || tool === 'rotate' || tool === 'scale') {
      useGizmoStore.getState().setMode(tool);
    }
  },
}));
