// cameraNode — the GRAPH-level "is this node a camera?" reach, answered in ONE place.
//
// The analogue of `lightNode.ts`, which the light split (#386) shipped for the same
// reason: a capability gate over a camera SUBJECT must be keyed on what the node IS
// (structure/possession), never on a type list each surface spells for itself (V119).
// Today the only form is the fused `PerspectiveCamera`/`OrthographicCamera`; the
// object↔data split (#387) adds the second — an `Object` posing a `CameraData` — and
// every site routed here gains it without a second edit.
//
// ⚠️ IT MUST STAY IMPORT-LIGHT. `resolveWorldTransform.ts` keeps its camera arm inline
// *because* importing `activeCamera` would cycle (activeCamera → trackTo →
// resolveWorldTransform, stated at resolveWorldTransform.ts:55 and :296). This module
// may import types and `linkedDataNodeId` only — never `activeCamera`, never THREE — or
// the cycle it exists to avoid comes back through the helper.
//
// REF: src/app/lightNode.ts (the template), src/app/activeCamera.ts
//      (enumerateCameraNodeIds — the enumeration this predicate will back); #387, #479.

import type { DagState } from '../core/dag/state';

/** The fused camera node types — the pre-split form, and the migration relics after. */
const FUSED_CAMERA_TYPES = new Set(['PerspectiveCamera', 'OrthographicCamera']);

/**
 * True iff `id` names a camera.
 *
 * COEXISTENCE: #387 extends this with the split form (an `Object` whose `data` input
 * poses a `CameraData`). Both forms must be accepted for as long as both can exist,
 * so every consumer keeps working through the migration rather than at the end of it.
 */
export function isCameraNode(state: DagState, id: string): boolean {
  const node = state.nodes[id];
  if (!node) return false;
  return FUSED_CAMERA_TYPES.has(node.type);
}
