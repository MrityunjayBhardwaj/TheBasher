// cameraNode — the GRAPH-level "is this node a camera, and where do its lens params live?"
// reach for the object↔data split (#387, Stage C · C4).
//
// The analogue of `lightNode.ts`, which the light split shipped for the same reason. Post
// split a camera is an `Object` posing a `CameraData`: the lens (projection, fov, near,
// far, lookAt, roll) lives on the CameraData, NOT on the node you selected or enumerated,
// while `position` stays on the Object that owns the TRS. The graph-level consumers — the
// camera enumeration, the active-camera rewire, the world transform, the gizmo dispatch,
// the strip picker, the first-key router and the agent's identify/addPass/shotCreate —
// all read `node.type` or node params and can NEVER be reached by the render-side
// recompose (`cameraRecompose.ts`). This is the ONE place the question is answered, so a
// future camera form is added once rather than in ten call sites (V101, V119).
//
// COEXISTENCE-SAFE: a still-fused camera (a project that has not migrated yet, and every
// project until slice 7 flips creation) is recognised too — every predicate accepts BOTH
// the fused node and the split Object. Deleting the fused arm before the fused types
// retire is the "live producer, removed consumer" violation.
//
// ⚠️ IT MUST STAY IMPORT-LIGHT. `resolveWorldTransform.ts` keeps its camera arm inline
// *because* importing `activeCamera` would cycle (activeCamera → nodeConstraints →
// resolveWorldTransform; stated at resolveWorldTransform.ts:55 and :296). This module may
// import types and `linkedDataNodeId` only — never `activeCamera`, never THREE. Both of
// its imports are checked: `resolveDataParamOwner` imports nothing but a type.
//
// REF: src/app/lightNode.ts (the template), src/app/activeCamera.ts (the pose road that
//      consumes the pair), src/nodes/CameraData.ts; #387, #479.

import type { DagState } from '../core/dag/state';
import type { Node } from '../core/dag/types';
import { linkedDataNodeId } from './resolveDataParamOwner';

/** The fused camera node types — the pre-split form, and the migration relics after. */
const FUSED_CAMERA_TYPES = new Set(['PerspectiveCamera', 'OrthographicCamera']);

/** A camera's projection, in the `CameraData.projection` vocabulary. The fused types are
 *  mapped onto it so one word answers for both forms. */
export type CameraProjection = 'Perspective' | 'Orthographic';

/** The `CameraData` node `id` poses through its `data` input, or null — a fused camera, a
 *  non-camera, or an Object posing some other kind of data.
 *
 *  The type test is not defensive padding: `linkedDataNodeId` returns whatever hangs off
 *  the `data` input, and reading lens params off a `BoxData` would silently produce
 *  `DEFAULT_CAMERA_POSE`'s values rather than an error — the same answer a total read
 *  failure gives, which is why this narrowing is pinned on its own contract and not
 *  through the pose road. */
export function cameraDataOf(state: DagState, id: string): Node | null {
  const dataId = linkedDataNodeId(state, id);
  if (!dataId) return null;
  const data = state.nodes[dataId] ?? null;
  return data?.type === 'CameraData' ? data : null;
}

/**
 * True iff `id` names a camera — a fused `PerspectiveCamera`/`OrthographicCamera`, OR an
 * Object posing a `CameraData`.
 *
 * POSSESSION, not identity (V119): post-split every camera's `node.type` is `'Object'`,
 * exactly like a cube's, so a type list cannot tell them apart and any gate still spelled
 * as one fails open. What makes a node a camera is that it poses a lens.
 */
export function isCameraNode(state: DagState, id: string): boolean {
  const node = state.nodes[id];
  if (!node) return false;
  return FUSED_CAMERA_TYPES.has(node.type) || cameraDataOf(state, id) !== null;
}

/**
 * The projection of the camera `id` describes, or null when it is not a camera.
 *
 * Split → the `CameraData`'s `projection` discriminator. Fused → the node's own type. The
 * discriminator is the ONLY road post-split: a split node's `type` is `'Object'` for both
 * projections, so a `type === 'OrthographicCamera'` test silently answers "perspective"
 * forever after.
 */
export function cameraProjectionFromPair(
  objectNode: Node | null,
  dataNode: Node | null,
): CameraProjection | null {
  if (!objectNode) return null;
  if (dataNode) {
    return (dataNode.params as { projection?: unknown }).projection === 'Orthographic'
      ? 'Orthographic'
      : 'Perspective';
  }
  if (!FUSED_CAMERA_TYPES.has(objectNode.type)) return null;
  return objectNode.type === 'OrthographicCamera' ? 'Orthographic' : 'Perspective';
}

/** {@link cameraProjectionFromPair} applied to a node id — resolves the data half itself. */
export function cameraProjectionOf(state: DagState, id: string): CameraProjection | null {
  const node = state.nodes[id] ?? null;
  if (!node) return null;
  return cameraProjectionFromPair(node, cameraDataOf(state, id));
}

/**
 * The params bag that OWNS the lens for camera `id` — the `CameraData`'s params when
 * split, the node's own when fused — or null when `id` is not a camera.
 *
 * `position` is deliberately NOT in here: it stays on the Object, which owns the TRS. A
 * caller reading a pose needs BOTH bags, which is why the pose road recombines the pair
 * rather than taking one of them.
 */
export function cameraLensParams(state: DagState, id: string): Record<string, unknown> | null {
  const node = state.nodes[id];
  if (!node) return null;
  const data = cameraDataOf(state, id);
  if (data) return data.params as Record<string, unknown>;
  return FUSED_CAMERA_TYPES.has(node.type) ? (node.params as Record<string, unknown>) : null;
}
