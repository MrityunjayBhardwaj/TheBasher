// activeCamera — pure helpers that locate the scene's active camera node and
// read its pose. Used by the editor view camera (#165): when the viewport
// no longer renders THROUGH the DAG camera (it owns a free orbit camera
// instead), it still needs the active camera's pose to (a) boot the orbit
// view at that framing — byte-identical to the old makeDefault behavior —
// and (b) adopt it when "look through camera" is toggled on.
//
// Discipline: pure functions of DagState. No THREE, no React, no DAG
// mutation — unit-testable in isolation. The selector returns the camera
// NODE (a referentially-stable object across unrelated store updates, since
// Basher applies Ops immutably) so a zustand subscriber re-renders ONLY when
// the camera node itself changes (pose edit, re-wire), never on every store
// tick. Reading params directly mirrors framing.ts `anchorForNode` and
// Gizmo's `getManipulable` — both read `params.position` for cameras. Camera
// animation via the transform-band layer system is not a thing today
// (cameras aim via `lookAt`, not the rotation band), so params == evaluated.
//
// REF: THESIS.md §11; vyapti V1, V8.

import type { DagState } from '../core/dag';
import type { Node } from '../core/dag/types';

export type CameraKind = 'PerspectiveCamera' | 'OrthographicCamera';

export interface CameraPose {
  kind: CameraKind;
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  near: number;
  far: number;
}

/** Default editor framing — matches THESIS.md §11 and the default project's
 *  seed camera, so a camera-less scene still boots at a sane angle. */
export const DEFAULT_CAMERA_POSE: CameraPose = {
  kind: 'PerspectiveCamera',
  position: [3, 2, 3],
  lookAt: [0, 0, 0],
  fov: 45,
  near: 0.1,
  far: 1000,
};

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/** Locate the node wired into `scene.camera`. Returns the Node object (stable
 *  identity) or null when no scene / no camera is wired. */
export function selectActiveCameraNode(state: DagState): Node | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;
  const sceneNode = state.nodes[sceneRef.node];
  if (!sceneNode) return null;
  const camRef = sceneNode.inputs.camera;
  // scene.camera is a single NodeRef (not a list), per cameraFromView.ts.
  const ref = Array.isArray(camRef) ? camRef[0] : camRef;
  if (!ref || typeof ref !== 'object' || !('node' in ref)) return null;
  const id = (ref as { node?: string }).node;
  if (!id) return null;
  return state.nodes[id] ?? null;
}

/** Read a camera node's pose from its params, with defensive defaults so a
 *  malformed or pre-field-existed project never throws. Returns null only for
 *  a null node (caller falls back to DEFAULT_CAMERA_POSE). */
export function cameraPoseFromNode(node: Node | null): CameraPose | null {
  if (!node) return null;
  const p = node.params as Record<string, unknown>;
  const kind: CameraKind =
    node.type === 'OrthographicCamera' ? 'OrthographicCamera' : 'PerspectiveCamera';
  return {
    kind,
    position: isVec3(p.position) ? p.position : DEFAULT_CAMERA_POSE.position,
    lookAt: isVec3(p.lookAt) ? p.lookAt : DEFAULT_CAMERA_POSE.lookAt,
    fov: typeof p.fov === 'number' ? p.fov : DEFAULT_CAMERA_POSE.fov,
    near: typeof p.near === 'number' ? p.near : DEFAULT_CAMERA_POSE.near,
    far: typeof p.far === 'number' ? p.far : DEFAULT_CAMERA_POSE.far,
  };
}

/** Convenience: the active camera's pose, or the default when none is wired. */
export function resolveActiveCameraPose(state: DagState): CameraPose {
  return cameraPoseFromNode(selectActiveCameraNode(state)) ?? DEFAULT_CAMERA_POSE;
}
