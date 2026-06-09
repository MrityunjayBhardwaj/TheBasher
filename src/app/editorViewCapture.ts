// editorViewCapture — a one-slot mailbox for the live editor-view pose,
// captured at the instant the editor-view PROJECTION flips (persp↔ortho).
//
// Why: a projection toggle unmounts the old drei camera and mounts a fresh one,
// which EditorViewCamera must re-pose. Re-posing from the LAST-PERSISTED orbit
// view (`editorViewPersistence`) is subtly wrong — OrbitControls `enableDamping`
// keeps easing after the gesture ends, so the persisted gesture-end pose has
// drifted from what the user is actually looking at. The toggle snapshots the
// LIVE camera pose first, so the swapped-in camera lands exactly where the view
// already was (Blender's Numpad-5 behavior: apparent framing preserved).
//
// Lifecycle: the toggle writes (before the store flips, while threeRef still
// mirrors the OLD free camera); the very next EditorViewCamera re-frame reads
// and clears. Single-slot — a projection toggle is always immediately followed
// by exactly one re-frame, so there is never more than one pending pose.
//
// File-rooted V8: src/app/. Reads the threeRef UI projection only; never the DAG.

import { useThreeRef } from './character/threeRef';

export interface EditorViewPose {
  position: [number, number, number];
  target: [number, number, number];
}

let pending: EditorViewPose | null = null;

/** Snapshot the live editor camera + orbit target. Called by the projection
 *  toggle BEFORE the store flips, so threeRef still mirrors the OLD free
 *  camera (ThreeBridge updates threeRef per-frame from the default camera; the
 *  swap to the new camera hasn't been committed yet). No-op when the live refs
 *  aren't ready (first frame before ThreeBridge runs). */
export function capturePendingEditorView(): void {
  const { camera, controlsTarget } = useThreeRef.getState();
  if (!camera) return;
  pending = {
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: controlsTarget ? [controlsTarget.x, controlsTarget.y, controlsTarget.z] : [0, 0, 0],
  };
}

/** Take + clear the pending pose (null if none). */
export function takePendingEditorView(): EditorViewPose | null {
  const p = pending;
  pending = null;
  return p;
}
