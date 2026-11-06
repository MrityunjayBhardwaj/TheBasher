// drawnWorldTransform — a node's world as the viewport DRAWS it: every ancestor with its own
// constraints applied (#1829).
//
// WHY THIS EXISTS. The renderer writes a Track-To's aim and a Follow-Path's point into the
// constrained object's own transform (`ConstrainedR`, SceneFromDAG.tsx) and draws its children
// INSIDE it, so the children turn and move with it. `resolveWorldTransform` builds every ancestor
// WITHOUT its constraints, on purpose: a constraint reads its inputs through it, and an input read
// that applied constraints could read the constraint's own result. That rule was applied to every
// reader, so the gizmo, the inspector, the agents and the viewport chrome read the child of an
// aimed object where it would be if the parent were not aimed (measured on #1829: drawn
// (2.195, 2.837, 0.366), read (0, 2, −3)).
//
// THE SPLIT, and how it stays cycle-free:
//   - `resolveWorldTransform` / `resolveParentWorldMatrix` — the INPUT read. Ancestors without
//     their constraints. Every constraint resolver (nodeConstraints.ts) and every helper it reaches
//     (the curve sample, a glTF bone, a driver's geometry sample) reads through it, unchanged.
//   - `resolveDrawnWorldTransform` / `resolveDrawnParentWorldMatrix` — this file. Each ancestor
//     with the aim and path the renderer gives it, from the SAME resolvers `ConstrainedR` calls,
//     so the read equals the drawing by construction.
//   Nothing in the constraint side imports this file, so applying an ancestor's constraint here
//   runs resolvers that read the input road. One road comes back, through a driver: see `applying`.
//
// AIMING AT YOUR OWN CHILD — the one true cycle (#1809): the child's drawn world depends on the
// parent's aim, and the aim reads the child. The aim keeps reading the child the input way (the
// parent un-aimed), exactly as today, and this read then places the child under the parent that
// aim produced, which is where it is drawn. It is not a fixed point; it is today's drawing, read
// back faithfully.
//
// The NODE BEING READ contributes its own transform without its own constraints, as on the input
// road: the readers that want its own aim or path fold it themselves (V665), and this file only
// fixes what it hangs from.
//
// A STOPGAP: the stack-view epic (#1805, #1810) makes a child take its parent's final world as an
// input, so the drawing and the read become one value and this file goes away.

import * as THREE from 'three';
import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { SceneChild } from '../nodes/types';
import {
  localMatrix,
  resolveParentWorldMatrixWith,
  resolveWorldTransformWith,
  type AncestorLocal,
  type WorldTransform,
} from './resolveWorldTransform';
import {
  relationalPoseStackForTarget,
  resolveConstraintPosition,
  resolveConstraintRotation,
} from './nodeConstraints';
import { aimPatch } from './resolvedRotation';
import { type ClockedCtx, ctxOnClockOf } from './subjectClock';

/**
 * The ancestors whose constraints are being applied right now. A constraint's own world reads take
 * the input road, but a driver on one of its settings can read an aimed camera below it through the
 * evaluated transform, and a camera's aim reads the drawn parent (cameraTrackTo.ts): the drawn read
 * re-enters here for the same ancestor. Measured without this: 536 nested applications, then a stack
 * overflow the driver road swallows as "unevaluable". So re-entry takes the ancestor un-applied,
 * which is what that driver read before this file existed.
 */
const applying = new Set<string>();

/**
 * An ancestor's local matrix as `ConstrainedR` draws it: its overlaid value, the Track-To's aim in
 * place of its rotation and the Follow-Path's point in place of its position. An ancestor no active
 * constraint targets — nearly all of them — costs one lookup in the memoised constraint index.
 */
const drawnAncestorLocal: AncestorLocal = (state, nodeId, value, ctx, cache) => {
  if (relationalPoseStackForTarget(state.nodes, nodeId).length === 0) return localMatrix(value);
  // Already being applied, further up this call: see `applying`.
  if (applying.has(nodeId)) return localMatrix(value);
  // The renderer resolves both bands on the node's own clock (`liveCtxOf`).
  const own = ctxOnClockOf(state, nodeId, ctx);
  applying.add(nodeId);
  let aim, followed;
  try {
    aim = resolveConstraintRotation(state, nodeId, own, cache);
    followed = resolveConstraintPosition(state, nodeId, own, cache);
  } finally {
    applying.delete(nodeId);
  }
  const rec = value as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  // The same two guards and the same patch `ConstrainedR` applies.
  if (aim && 'rotation' in rec) Object.assign(patch, aimPatch(rec, aim));
  if (followed && 'position' in rec) patch.position = followed;
  if (Object.keys(patch).length === 0) return localMatrix(value);
  return localMatrix({ ...rec, ...patch } as unknown as SceneChild);
};

/**
 * `selectedId`'s world as it is drawn: {@link resolveWorldTransform} with every ancestor's
 * constraints applied (#1829). For readers that place, pick or report a thing — the gizmo, the
 * agents' world read, the viewport chrome. Never for a constraint's own inputs: those read
 * `resolveWorldTransform`, or a constraint could read its own result.
 */
export function resolveDrawnWorldTransform(
  state: DagState,
  selectedId: string,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): WorldTransform | null {
  return resolveWorldTransformWith(state, selectedId, ctx, cache, drawnAncestorLocal);
}

/** The world of what `selectedId` hangs from, as it is drawn ({@link resolveDrawnWorldTransform}).
 *  Null when it hangs from nothing or from an identity, as `resolveParentWorldMatrix` answers, so
 *  the child of an aimed cube at the origin, null on that read, has a parent here. */
export function resolveDrawnParentWorldMatrix(
  state: DagState,
  selectedId: string,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): THREE.Matrix4 | null {
  return resolveParentWorldMatrixWith(state, selectedId, ctx, cache, drawnAncestorLocal);
}
