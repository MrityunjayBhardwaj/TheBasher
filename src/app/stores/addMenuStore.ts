// addMenuStore — UI projection for the Blender-style "Add" context menu.
//
// Open at a screen position (for right-click) or at viewport center (for
// Shift+A). Clicking outside or pressing Esc closes it. The action that
// executes the add lives in AddMenu.tsx; the store carries only the
// open-state + position.

import { create } from 'zustand';

export interface AddMenuStore {
  open: boolean;
  /** Page-coords (CSS pixels) of the menu's top-left. */
  x: number;
  y: number;
  openAt(x: number, y: number): void;
  close(): void;
}

export const useAddMenuStore = create<AddMenuStore>((set) => ({
  open: false,
  x: 0,
  y: 0,
  openAt(x, y) {
    set({ open: true, x, y });
  },
  close() {
    set({ open: false });
  },
}));
