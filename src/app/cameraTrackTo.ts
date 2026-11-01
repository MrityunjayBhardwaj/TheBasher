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
import { resolveActiveTrackTo, resolveTrackToTarget } from './nodeConstraints';
import { resolveParentWorldMatrix } from './resolveWorldTransform';
import type { ClockedCtx } from './subjectClock';
import { trackToQuaternion } from './resolveTrackTo';
import { quaternionFromEulerDeg, withResolvedRotation } from './resolvedRotation';
import type { Quat, RotationModeFields } from '../nodes/types';

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
): { lookAt: Vec3; roll: number; up: Vec3 } | null {
  const aim = resolveTrackToTarget(state, cameraId, ctx, cache);
  if (!aim) return null;
  const winner = resolveActiveTrackTo(state, cameraId, ctx, cache);
  const roll = winner?.roll ?? 0;
  const up: Vec3 = winner ? [...winner.up] : [0, 1, 0];
  const parentWorld = resolveParentWorldMatrix(state, cameraId, ctx, cache);
  if (!parentWorld) return { lookAt: aim, roll, up };
  const local = new THREE.Vector3(aim[0], aim[1], aim[2]).applyMatrix4(
    parentWorld.clone().invert(),
  );
  return { lookAt: [local.x, local.y, local.z], roll, up };
}

/** What a camera's own transform holds for its orientation, keys already overlaid: its
 *  `rotation`, read in the mode it is in (`rotationMode`, `quaternion`). */
export type CameraOwnRotation = RotationModeFields & { rotation: Vec3 };

/**
 * #1760 — a camera's orientation in its parent's space, by the rule every object follows (V665):
 * its winning Track-To's aim and roll, else its Object's own rotation. The Track-To's aim is taken
 * from `position`, the camera's parent-local position with its keys and path applied. `lensRoll`
 * is the lens's roll, which adds to an aim until #1764 removes it (the v26 step sets it to 0).
 * `aim` is the Track-To's aim point in the parent's space, or null when the camera's own rotation
 * turns it.
 */
export function cameraLocalOrientation(
  state: DagState,
  cameraId: string,
  position: Vec3,
  own: CameraOwnRotation,
  lensRoll: number,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): { quaternion: Quat; aim: Vec3 | null } {
  const tracked = cameraTrackToAim(state, cameraId, ctx, cache);
  if (tracked) {
    const q = trackToQuaternion(position, tracked.lookAt, tracked.up, tracked.roll + lensRoll);
    // A degenerate aim (the camera sits on its aim point) aims nothing; its own rotation stands.
    if (q) return { quaternion: [q.x, q.y, q.z, q.w], aim: tracked.lookAt };
  }
  const { rotation } = withResolvedRotation(own);
  return { quaternion: quaternionFromEulerDeg(rotation), aim: null };
}
