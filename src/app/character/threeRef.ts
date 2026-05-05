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

export interface ThreeRefStore {
  camera: THREE.Camera | null;
  controlsTarget: THREE.Vector3 | null;
  set: (camera: THREE.Camera | null, target: THREE.Vector3 | null) => void;
}

export const useThreeRef = create<ThreeRefStore>((set) => ({
  camera: null,
  controlsTarget: null,
  set: (camera, controlsTarget) => set({ camera, controlsTarget }),
}));
