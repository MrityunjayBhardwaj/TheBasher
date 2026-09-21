// threeRef — UI projection that exposes the editor camera + OrbitControls
// target to code OUTSIDE the Canvas (e.g. KeyboardShortcuts in the React
// tree, the Camera-from-View menu action).
//
// Why a store? Camera-from-view is triggered by a keyboard shortcut or a
// menu click — both fire outside the R3F render tree, so they can't call
// useThree(). A small zustand projection bridges the gap: a
// <ThreeBridge /> component lives inside the Canvas, useThree-reads the
// active camera + controls' target every frame (cheap), and writes them
// to this store. Callers pull via useThreeRef.getState().
//
// V8 stays clean: this store is a UI projection, not the DAG. The bridge
// component lives in src/app/ (file-rooted V8).

import * as THREE from 'three';
import { create } from 'zustand';

/** OrbitControls' dolly range — the part of the controls a framing gesture has to move. */
export interface DollyLimits {
  minDistance: number;
  maxDistance: number;
}

export interface ThreeRefStore {
  camera: THREE.Camera | null;
  controlsTarget: THREE.Vector3 | null;
  /** #1179 — the live controls' dolly range. OrbitControls clamps the camera's distance into
   *  it on every update, so a fit that moves the camera past it without moving the range is
   *  undone on the next frame. Null when there are no controls (tests, before mount). */
  dollyLimits: DollyLimits | null;
  /** Live WebGLRenderer + scene root — pushed by ThreeBridge so out-of-Canvas
   *  actions (the "Render Image" menu/keybind, #168) can render the scene
   *  offscreen without a useThree() context. Set once on mount, not per frame. */
  gl: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  set: (
    camera: THREE.Camera | null,
    target: THREE.Vector3 | null,
    dollyLimits?: DollyLimits | null,
  ) => void;
  setRenderRefs: (gl: THREE.WebGLRenderer | null, scene: THREE.Scene | null) => void;
}

export const useThreeRef = create<ThreeRefStore>((set) => ({
  camera: null,
  controlsTarget: null,
  dollyLimits: null,
  gl: null,
  scene: null,
  set: (camera, controlsTarget, dollyLimits = null) => set({ camera, controlsTarget, dollyLimits }),
  setRenderRefs: (gl, scene) => set({ gl, scene }),
}));
