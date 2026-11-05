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
import { resolveActiveTrackTo, resolveTrackToStack, resolveTrackToTarget } from './nodeConstraints';
import { resolveParentWorldMatrix } from './resolveWorldTransform';
import type { ClockedCtx } from './subjectClock';
import { trackToQuaternion, trackToUpIn } from './resolveTrackTo';
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
  const parentWorld = resolveParentWorldMatrix(state, cameraId, ctx, cache);
  if (!parentWorld) return { lookAt: aim, roll, up };
  // #1770 — the up in the parent's frame the camera aims in, read in the Track-To's own space.
  if (winner) up = trackToUpIn(up, winner.aimSpace, 'parent', parentWorld);
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
 * its Track-Tos' aims, else its Object's own rotation. Each Track-To's aim is taken from
 * `position`, the camera's parent-local position with its keys and path applied, with the
 * Track-To's own roll, the only bank on an aim (#1764: the lens has none).
 *
 * #1783 — the stack blends bottom → top by each member's influence, by slerp from the camera's own
 * rotation, as the mesh road does (`resolveConstraintRotation`) and as Blender 5.1.1's constraint
 * Influence does. At full influence the top member that aims decides alone, exactly as before.
 * `aim` is the aim point of the top member that aims, in the parent's space (under a partial
 * influence too: it is the point focus-on-target measures to and the reticle sits on), or null
 * when the camera's own rotation turns it.
 */
export function cameraLocalOrientation(
  state: DagState,
  cameraId: string,
  position: Vec3,
  own: CameraOwnRotation,
  ctx: ClockedCtx,
  cache?: EvaluatorCache,
): { quaternion: Quat; aim: Vec3 | null } {
  const ownQuat = (): THREE.Quaternion => {
    const { rotation } = withResolvedRotation(own);
    return new THREE.Quaternion(...quaternionFromEulerDeg(rotation));
  };
  const stack = resolveTrackToStack(state, cameraId, ctx, cache);
  const parentWorld =
    stack.length > 0 ? resolveParentWorldMatrix(state, cameraId, ctx, cache) : null;
  const toParent = parentWorld ? parentWorld.clone().invert() : null;
  let q: THREE.Quaternion | null = null;
  let aim: Vec3 | null = null;
  for (const member of stack) {
    if (member.influence <= 0) continue;
    // #1766 — the aim brought into the parent's space; #1770 — the up read in the Track-To's own
    // space, in the parent's frame the camera aims in.
    const w = member.targetWorld;
    const local = toParent ? new THREE.Vector3(w[0], w[1], w[2]).applyMatrix4(toParent) : null;
    const lookAt: Vec3 = local ? [local.x, local.y, local.z] : [w[0], w[1], w[2]];
    const up: Vec3 = parentWorld
      ? trackToUpIn([...member.up], member.aimSpace, 'parent', parentWorld)
      : [...member.up];
    const m = trackToQuaternion(position, lookAt, up, member.roll);
    // A degenerate aim (the camera sits on its aim point) aims nothing.
    if (!m) continue;
    q = member.influence >= 1 ? m : (q ?? ownQuat()).clone().slerp(m, member.influence);
    // Under a partial influence too, the point the blend leans toward: what focus-on-target
    // focuses on and where the aim reticle sits. The orientation is the blend's, on the pose.
    aim = lookAt;
  }
  if (q) return { quaternion: [q.x, q.y, q.z, q.w], aim };
  const o = ownQuat();
  return { quaternion: [o.x, o.y, o.z, o.w], aim: null };
}
