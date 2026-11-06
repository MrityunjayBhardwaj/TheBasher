// #1810 — an object's world transform as a value on a wire.
//
// A posable node (Object, Group, Null) has a `parent` input and a `world` output, as Houdini's
// object-level parenting does: world = the parent input's world × the object's own transform. The
// evaluator produces the `world` output through this fold (`setWorldFold`), because the own
// transform folds the object's keys, strips, drivers and held edits, which live off the graph.
//
// The fold reads exactly what `resolveWorldTransform` reads for one level of its walk, through the
// same functions (`overlaidAt`, `localMatrix`, `cameraLocalPose`, `boneParentMatrix`), so a chain
// of parent wires composes to what that walk composes down the `children` wires today. What it
// does NOT do is evaluate the scene: the object's own value is its node's evaluate on its params
// alone (a world needs its transform, not its children), and its channels come from the scene
// index's slice for that one node. So reading one object's world costs its own channels plus its
// parent's world, not the scene (the #1809 trial measured ~936 cache reads per object read through
// `resolveEvaluatedTransform` at 500 objects).
//
// Until saved files are converted (#1824), parenting has two sources: the `children` wires, which
// the renderer, the outliner and `resolveWorldTransform` read, and the `parent` input, which only
// the `world` output reads. They are independent: the `world` output follows the `parent` input and
// nothing else. A child hung in some Group's `children` with no parent input reads its own
// transform as its world; a parent input with no `children` wire is honoured all the same.
// Wiring the SAME relation both ways (B in A's `children`, A's world into B's `parent`) is a loop
// between the two nodes, and `connect` refuses it.
//
// Not yet: a constraint (#1811) — like `resolveWorldTransform`, this is the world before any
// constraint, the one a Track-To reads its target from today.

import * as THREE from 'three';
import { requireNodeType } from '../core/dag/registry';
import { evaluate, setWorldFold, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type { SceneChild } from '../nodes/types';
import { boneParentMatrix } from '../nodes/boneParent';
import { isCameraNode } from './cameraNode';
import {
  cameraLocalMatrix,
  cameraLocalPose,
  localMatrix,
  overlaidAt,
  type Overlay,
} from './resolveWorldTransform';
import { useTransientEditStore } from './stores/transientEditStore';
import { type ClockedCtx, ctxOnClock, ctxOnClockOf } from './subjectClock';

/** `id`'s own value with nothing wired in: the node's evaluate on its params alone. A world needs
 *  the object's transform, never its children or its data. */
function ownValueOf(state: DagState, id: string, ctx: EvalCtx): SceneChild {
  const node = state.nodes[id];
  return requireNodeType(node.type).evaluate(node.params, {}, ctx) as SceneChild;
}

export function objectWorldFold(
  state: DagState,
  id: string,
  parent: readonly number[] | null,
  parentId: string | null,
  evalCtx: EvalCtx,
  cache: EvaluatorCache | undefined,
): number[] {
  // As `resolveWorldTransform`: the tree runs at scene time, each node re-timed onto its clock.
  const ctx = ctxOnClock(state, 'scene', evalCtx as ClockedCtx);
  const world = parent ? new THREE.Matrix4().fromArray(parent) : new THREE.Matrix4();
  // A camera's own transform is its pose (keys and held edits on its own clock), drawn unscaled.
  if (isCameraNode(state, id)) {
    return world.multiply(cameraLocalMatrix(cameraLocalPose(state, id, ctx, cache))).toArray();
  }
  // The world before constraints (#1811), so an ancestor contributes its plain local matrix.
  const at: Overlay = {
    ctx,
    cache,
    transients: useTransientEditStore.getState().edits,
    ancestorLocal: (_state, _id, value) => localMatrix(value),
  };
  const own = ownValueOf(state, id, ctx);
  const drawn = overlaidAt(state, id, own, at) ?? own;
  // A child parented to a bone hangs from that bone's pose, as `underParent` composes it.
  const boneName = (drawn as { parentBone?: unknown }).parentBone;
  if (typeof boneName === 'string' && parentId && state.nodes[parentId]) {
    const bone = boneOf(state, parentId, drawn, at);
    if (bone) world.multiply(bone);
  }
  return world.multiply(localMatrix(drawn)).toArray();
}

/** The pose matrix of the bone `child` names, on the armature `parentId`, as drawn. */
function boneOf(
  state: DagState,
  parentId: string,
  child: SceneChild,
  at: Overlay,
): THREE.Matrix4 | null {
  let armature: unknown;
  try {
    armature = evaluate(state, parentId, { cache: at.cache, ctx: at.ctx }).value;
  } catch {
    return null;
  }
  const drawn = overlaidAt(state, parentId, armature as SceneChild, at);
  if (!drawn) return null;
  const seconds = ctxOnClockOf(state, parentId, at.ctx).time.seconds;
  return boneParentMatrix(drawn, child, seconds);
}

/** Hands the evaluator its road to the world fold. Called by `registerAllNodes`. */
export function registerWorldFold(): void {
  setWorldFold(objectWorldFold);
}
