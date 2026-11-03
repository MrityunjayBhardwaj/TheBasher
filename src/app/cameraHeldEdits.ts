// #1773 — a camera's held edits. With Auto-Key off, an edit to a keyed param is held (the orange
// field) until it is keyed or the frame changes, and it shows on top of the keys. An object's
// road lays held edits on with `overlayTransients` (resolveEvaluatedTransform, SceneFromDAG); a
// camera's two roads lay its keys on with `overlayCameraChannels` and nothing after, so a held
// edit on a camera turned the field orange and moved nothing. This is the step after: the same
// primitive, the same live store read (empty store → the bag unchanged), on both halves of the
// camera — its Object (position, rotation) and its lens (fov, clip, ortho scale, …).
//
// Only the names the bag already carries are laid on, so a held edit on anything else (a
// scale the pose does not read) cannot add a field the pose never had.
//
// REF: src/app/overlayTransients.ts (the primitive), src/app/activeCamera.ts
//      (resolveCameraPoseAt), src/app/resolveWorldTransform.ts (cameraLocalPose).

import type { DagState } from '../core/dag/state';
import { cameraDataOf } from './cameraNode';
import { overlayTransients } from './overlayTransients';
import { useTransientEditStore, type TransientEdit } from './stores/transientEditStore';

export function withHeldCameraEdits<T extends object>(
  state: DagState,
  cameraId: string,
  bag: T,
): T {
  const all = useTransientEditStore.getState().edits;
  if (all.size === 0) return bag;
  const owners = new Set([cameraId, cameraDataOf(state, cameraId)?.id].filter(Boolean));
  const edits = new Map<string, TransientEdit>();
  for (const [k, e] of all) {
    if (owners.has(e.nodeId) && e.paramPath.split('.')[0] in bag) edits.set(k, e);
  }
  if (edits.size === 0) return bag;
  // Both halves' edits land on the one bag: rewrite them onto the camera's id for the primitive.
  const onCamera = new Map<string, TransientEdit>();
  for (const [k, e] of edits) onCamera.set(k, { ...e, nodeId: cameraId });
  return overlayTransients(bag, cameraId, onCamera) ?? bag;
}
