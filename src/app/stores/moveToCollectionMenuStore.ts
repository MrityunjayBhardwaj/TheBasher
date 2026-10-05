// #397 — UI projection for Blender's Move to Collection menu (M): open-state and position only. The
// move itself lives in `collections.ts` (`moveToCollectionOps`); the menu in MoveToCollectionMenu.

import { create } from 'zustand';

export interface MoveToCollectionMenuStore {
  open: boolean;
  /** Page-coords (CSS pixels) of the menu's top-left. */
  x: number;
  y: number;
  openAt(x: number, y: number): void;
  close(): void;
}

export const useMoveToCollectionMenuStore = create<MoveToCollectionMenuStore>((set) => ({
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
