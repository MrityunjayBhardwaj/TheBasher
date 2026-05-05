// editorStore — UI projection for the active editor space (which view
// fills the center pane of the layout).
//
// Blender-style: the user toggles between 3D Viewport and UV Editor
// (later: Timeline editor, Graph editor, Outliner). The 3D Canvas does
// NOT unmount when the user switches space — Layout flips slot
// visibility via display:none, mirroring K1 step 6's discipline (Canvas
// mounts ONCE; mode/space switches must not drop GPU state).
//
// File-rooted V8: this store is a UI projection, mutated only by
// src/app/* surfaces. Never touches the DAG.
//
// REF: THESIS.md §11 (viewport), §17 (mode hierarchy — sister concept).

import { create } from 'zustand';

export type SpaceType = 'view3d' | 'uv';

export interface EditorStore {
  /** Which editor occupies the center pane right now. */
  space: SpaceType;
  setSpace(space: SpaceType): void;
  /** Cycle to the next space — wired to Tab in KeyboardShortcuts. */
  toggleSpace(): void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  space: 'view3d',
  setSpace(space) {
    set({ space });
  },
  toggleSpace() {
    set({ space: get().space === 'view3d' ? 'uv' : 'view3d' });
  },
}));
