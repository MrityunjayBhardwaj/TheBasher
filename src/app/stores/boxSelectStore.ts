// Box-select UI state (#226). Like selectionStore/viewportStore this is a pure UI
// projection — it never touches the DAG (V1/V8). `active` is the modal flag (the
// `B` shortcut sets it); `rect` is the live marquee in canvas-relative CSS px the
// DOM overlay draws. The in-Canvas BoxSelect component registers `commit` once it
// has the camera + canvas size, so the DOM overlay can run the world-space hit
// test across the Canvas boundary without prop-drilling.

import { create } from 'zustand';
import type { PixelRect } from '../../viewport/boxSelect';

export interface BoxSelectStore {
  /** True while box-select mode is armed (B pressed) — the crosshair overlay is up. */
  active: boolean;
  /** Live marquee rect (canvas-relative px), or null before the drag starts. */
  rect: PixelRect | null;
  /** Registered by the in-Canvas BoxSelect: run the hit test for `rect` and apply
   *  the selection (additive when Shift was held at release). Null until mounted. */
  commit: ((rect: PixelRect, additive: boolean) => void) | null;

  /** Arm box-select mode (B). */
  begin: () => void;
  /** Update the live marquee while dragging. */
  setRect: (rect: PixelRect | null) => void;
  /** Exit box-select mode without changing the selection (Esc / RMB / click-no-drag). */
  cancel: () => void;
  /** Register / clear the in-Canvas commit callback. */
  setCommit: (commit: BoxSelectStore['commit']) => void;
}

export const useBoxSelectStore = create<BoxSelectStore>((set) => ({
  active: false,
  rect: null,
  commit: null,

  begin() {
    set({ active: true, rect: null });
  },
  setRect(rect) {
    set({ rect });
  },
  cancel() {
    set({ active: false, rect: null });
  },
  setCommit(commit) {
    set({ commit });
  },
}));
