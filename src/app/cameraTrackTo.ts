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
import {
  resolveActiveTrackTo,
  resolveConstraintRotation,
  resolveFollowedWorldPosition,
  resolveTrackToTarget,
} from './nodeConstraints';
import { resolveDrawnParentWorldMatrix } from './drawnWorldTransform';
import type { ClockedCtx } from './subjectClock';
import { trackToUpIn } from './resolveTrackTo';
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
  let up: Vec3 = winner ? [...winner.up] : [0, 1, 0];
  // #1829 — the drawn parent, the one `resolveCameraPoseAt` lifts this pose by: the aim is
  // brought into the space it is lifted out of, so a camera under an aimed object still frames its
  // target. No cycle: a camera's aim enters no world read (a world read takes its own rotation).
  const parentWorld = resolveDrawnParentWorldMatrix(state, cameraId, ctx, cache);
  if (!parentWorld) return { lookAt: aim, roll, up };
  // #1770 — the up in the parent's frame the camera aims in, read in the Track-To's own space.
  if (winner) up = trackToUpIn(up, winner.aimSpace, 'parent', parentWorld);
  const local = new THREE.Vector3(aim[0], aim[1], aim[2]).applyMatrix4(
    parentWorld.clone().invert(),
  );
  return { lookAt: [local.x, local.y, local.z], roll, up };
}

/** #1829 — the point a camera's Follow-Path puts it at, in the space its pose is lifted out of: the
 *  drawn parent, as for its aim above, so a camera under an aimed object stays on its path. Null
 *  when no Follow-Path moves it. A top-level camera's parent is the world. */
export function cameraFollowedPosition(
  state: DagState,
  cameraId: string,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): Vec3 | null {
  const world = resolveFollowedWorldPosition(state, cameraId, ctx, cache);
  if (!world) return null;
  const parentWorld = resolveDrawnParentWorldMatrix(state, cameraId, ctx, cache);
  if (!parentWorld) return world;
  const local = new THREE.Vector3(...world).applyMatrix4(parentWorld.clone().invert());
  return [local.x, local.y, local.z];
}

/** What a camera's own transform holds for its orientation, keys already overlaid: its
 *  `rotation`, read in the mode it is in (`rotationMode`, `quaternion`). */
export type CameraOwnRotation = RotationModeFields & { rotation: Vec3 };

/**
 * #1760 — a camera's orientation in its parent's space, by the rule every object follows (V665):
 * its winning Track-To's aim and roll, else its Object's own rotation. The aim is the camera's constraint chain. The
 * Track-To's own roll is the only bank on an aim (#1764: the lens has none).
 * `aim` is the Track-To's aim point in the parent's space, or null when the camera's own rotation
 * turns it.
 */
export function cameraLocalOrientation(
  state: DagState,
  cameraId: string,
  own: CameraOwnRotation,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): { quaternion: Quat; aim: Vec3 | null } {
  const tracked = cameraTrackToAim(state, cameraId, ctx, cache);
  // A degenerate aim (the camera sits on its aim point) aims nothing; its own rotation stands.
  const aimed = tracked ? resolveConstraintRotation(state, cameraId, ctx, cache) : null;
  if (tracked && aimed) return { quaternion: quaternionFromEulerDeg(aimed), aim: tracked.lookAt };
  const { rotation } = withResolvedRotation(own);
  return { quaternion: quaternionFromEulerDeg(rotation), aim: null };
}
