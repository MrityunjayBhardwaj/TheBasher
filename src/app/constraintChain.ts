// constraintChain — what a constraint does to the transform coming up its chain (#1811).
//
// A chain is wires: OwnWorld → step → step → the object's `constraints` input. Each step takes the
// whole transform the one below left, as Blender runs its list (`BKE_constraints_solve`), so the
// order of the wires is the order of the stack.
//
// The maths are Blender 5.1.1's where Basher does the same thing, measured in
// `constraintChain.blender.test.ts`:
//   - Track-To replaces the rotation, aiming from the position it receives. The position and the
//     length of each axis stay, so a stretch from an unevenly scaled parent becomes plain scale and
//     no shear reaches the aim. A target reads as its final world, after its own chain and its parents.
//   - Follow Path keeps the position it receives as an offset from the path: the point on the path
//     plus that position through the curve object's rotation and scale (`followpath_evaluate`:
//     `owner = curveWorld · T(point) · owner`). It takes position only; Blender also turns the
//     object by the curve object's rotation, which Basher doesn't do yet (#1796).
//
// A muted or degenerate step (nothing to aim at, standing on the target, no curve) hands on what
// it received. Settings are read through `resolveEvaluatedParam`, the render's own read, so keys,
// strips and drivers on them count.

import * as THREE from 'three';
import { setWorldStepFold, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeRef } from '../core/dag/types';
import { curveSamplerFor } from './curveSampleSource';
import { gltfNodeWorldPosition } from './gltfNodeWorld';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { trackToQuaternion, trackToUpIn } from './resolveTrackTo';

type Vec3 = [number, number, number];
type Inputs = Readonly<Record<string, unknown>>;
type Refs = Readonly<Record<string, NodeRef>>;

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');

function matrixOf(inputs: Inputs, socket: string): THREE.Matrix4 | null {
  const m = inputs[socket];
  return Array.isArray(m) ? new THREE.Matrix4().fromArray(m as number[]) : null;
}

function trackToStep(
  state: DagState,
  id: string,
  below: THREE.Matrix4,
  inputs: Inputs,
  refs: Refs,
  ctx: EvalCtx,
  cache: EvaluatorCache | undefined,
): THREE.Matrix4 {
  const params = state.nodes[id].params as {
    aimBone: string;
    aimPoint: Vec3;
    aimSpace: 'world' | 'parent';
    up: Vec3;
    roll: number;
  };
  const read = (path: 'aimPoint' | 'up' | 'roll') =>
    resolveEvaluatedParam(state, id, path, ctx, cache)?.value;
  const up = read('up');
  const roll = read('roll');
  const parent = matrixOf(inputs, 'parent');

  let target: Vec3 | null = null;
  // A bone of the character wired in: its posed position (Blender's `subtarget`). A name that
  // doesn't resolve falls to the object itself.
  if (refs.aim && params.aimBone) {
    target = gltfNodeWorldPosition(state, refs.aim.node, params.aimBone, ctx, cache);
  }
  const aim = matrixOf(inputs, 'aim');
  if (!target && aim) {
    const p = new THREE.Vector3().setFromMatrixPosition(aim);
    target = [p.x, p.y, p.z];
  }
  if (!target) {
    const point = read('aimPoint');
    const fixed = isVec3(point) ? point : params.aimPoint;
    if (params.aimSpace === 'parent' && parent) {
      const p = new THREE.Vector3(...fixed).applyMatrix4(parent);
      target = [p.x, p.y, p.z];
    } else target = fixed;
  }

  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  below.decompose(position, rotation, scale);
  // The lengths of the axes, as Blender keeps them: a mirror below an aim is lost, its axes don't
  // flip (measured under a parent scaled -1 on X, 4.5.9 and 5.1.1).
  scale.set(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  const aimed = trackToQuaternion(
    [position.x, position.y, position.z],
    target,
    trackToUpIn(isVec3(up) ? up : params.up, params.aimSpace, 'world', parent),
    typeof roll === 'number' && Number.isFinite(roll) ? roll : params.roll,
  );
  return aimed ? new THREE.Matrix4().compose(position, aimed, scale) : below;
}

function followPathStep(
  state: DagState,
  id: string,
  below: THREE.Matrix4,
  inputs: Inputs,
  refs: Refs,
  ctx: EvalCtx,
  cache: EvaluatorCache | undefined,
): THREE.Matrix4 {
  const curve = matrixOf(inputs, 'curve');
  if (!curve || !refs.curve) return below;
  const params = state.nodes[id].params as { evalTime: number; offset: number };
  const resolved = resolveEvaluatedParam(state, id, 'evalTime', ctx, cache)?.value;
  const evalTime = typeof resolved === 'number' ? resolved : params.evalTime;
  const sampler = curveSamplerFor(state, refs.curve.node, ctx, cache, curve.toArray());
  if (!sampler) return below;
  const point = sampler.pointAt(evalTime + params.offset);
  // The curve's translation is already in the sampled point.
  const offset = new THREE.Vector3()
    .setFromMatrixPosition(below)
    .applyMatrix4(curve.clone().setPosition(0, 0, 0));
  return below.clone().setPosition(point[0] + offset.x, point[1] + offset.y, point[2] + offset.z);
}

/** One step of a chain. See the file header. */
export function constraintStepFold(
  state: DagState,
  id: string,
  inputs: Inputs,
  refs: Refs,
  ctx: EvalCtx,
  cache: EvaluatorCache | undefined,
): number[] {
  const node = state.nodes[id];
  const below = matrixOf(inputs, 'in') ?? new THREE.Matrix4();
  if ((node.params as { mute?: boolean }).mute === true) return below.toArray();
  const step = node.type === 'FollowPath' ? followPathStep : trackToStep;
  return step(state, id, below, inputs, refs, ctx, cache).toArray();
}

/** Hands the evaluator its road to the chain's steps. Called by `registerAllNodes`. */
export function registerWorldStepFold(): void {
  setWorldStepFold(constraintStepFold);
}
