// cameraTrackTo — a camera's Track-To aim, in the space its `lookAt` is in.
//
// #1766 — a Track-To resolves to a WORLD position, but a camera's `lookAt` is in its PARENT's
// space: the pose is built locally and then lifted by the parent group. Fed in raw, a world aim
// gets the parent's transform applied a second time, so a camera inside a moved group framed the
// wrong thing. Every road that turns a camera's Track-To into its `lookAt` comes through here.
//
// Its own module because it needs both the constraint resolver and the parent walk, and
// `resolveWorldTransform` cannot import the constraint side (the import would cycle).

import * as THREE from 'three';
import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { activeConstraintForTarget, resolveTrackToTarget } from './nodeConstraints';
import { resolveParentWorldMatrix } from './resolveWorldTransform';
import type { ClockedCtx } from './subjectClock';

type Vec3 = [number, number, number];

/** The camera's Track-To aim brought into its parent's space, ready to stand in for its
 *  `lookAt`, and the Track-To's own roll (#1759), which the camera adds to its lens roll; null
 *  when no Track-To aims it. A top-level camera's parent is the world, so its aim comes back
 *  unchanged. */
export function cameraTrackToAim(
  state: DagState,
  cameraId: string,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): { lookAt: Vec3; roll: number } | null {
  const aim = resolveTrackToTarget(state, cameraId, ctx, cache);
  if (!aim) return null;
  const roll = activeConstraintForTarget(state.nodes, cameraId)?.roll ?? 0;
  const parentWorld = resolveParentWorldMatrix(state, cameraId, ctx, cache);
  if (!parentWorld) return { lookAt: aim, roll };
  const local = new THREE.Vector3(aim[0], aim[1], aim[2]).applyMatrix4(
    parentWorld.clone().invert(),
  );
  return { lookAt: [local.x, local.y, local.z], roll };
}
