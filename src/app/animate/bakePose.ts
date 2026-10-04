// bakePose — turn computed motion into keys on a pose layer (#1215, step 6 of "Bones as Channels").
//
// A character's pose is the chain under its armature Object: a source at the bottom (a retarget's
// `posed`, a clip's `pose`, or the skeleton's rest pose under a base layer), layers above it, the
// Object at the top. Computed motion stays on the wire, regenerable. Baking is the ONLY road from it
// to keys a director can edit (design rule 9): there is no copy on first edit.
//
//   before   source ─────────────────────► bottom layer … ─► Object
//   after    Skeleton.pose ─► BAKED LAYER ─► bottom layer … ─► Object      (source detached, kept)
//
// What is baked is the wire at one point of the chain: its SOURCE (default), or the output of one of
// its layers — then that layer and every layer below it are folded into the keys and muted, never
// removed. Either way the baked layer is an override layer on the rest pose at the bottom of the
// chain, which makes it the chain's base (`poseLayerChain(...).base`): the character's own motion, as
// an imported file's is. Layers above the baked point keep their keys and keep editing what arrives.
//
// ── WHAT IT CORRESPONDS TO ──────────────────────────────────────────────────────────────────────
//
// Blender `nla.bake` (`bl_operators/anim.py:193-315`) → `bake_action_iter` (`bpy_extras/anim_utils.py
// :246-660`): sample each frame of a range (with a frame step), key every bone's local transform into
// a NEW action made the active one, blend forced to REPLACE, LINEAR on every key (`:733-746`), each
// quaternion made compatible with the previous one (`:521-531`). Houdini: Rig Pose's Bake Range keys
// its input into override transformations, interpolation constant / linear / bezier
// (`kinefx--rigpose.txt:571-600`); from a MotionClip, a key at each pose, thinned first by keeping
// every Nth pose with the range's ends always kept, or by Extract Key Poses (`kinefx-motionclips.txt
// :84-109`). Sources under `ref/sources/blender-bake-action-v5.1.1/`, `ref/sources/houdini-kinefx-docs/`.
//
// Differences, on purpose: every bone is keyed in quaternion mode with position, rotation and scale
// (Blender keys all three and every rotation mode's curves; a layer finds a channel by bone and
// component, so a curve for another mode would be a second answer). The Nth thinning keeps the last
// pose, as Houdini's does; Blender's `range(start, end + 1, step)` can drop it. Bezier fitting,
// Extract Key Poses and Blender's "clean curves" are not here.
//
// REF: src/app/animate/poseChain.ts (`poseLayerChain`); src/nodes/PoseLayer.ts; src/nodes/RetargetClip.ts
//      (`wirePoseTimes`, the one "every pose" rule); design ref/architecture/bone-channels-design.html
//      (v7, step 6, rule 9); issue #1215.

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { evaluate } from '../../core/dag/evaluator';
import {
  PoseLayerParams,
  type PoseLayerChannel,
  type PoseLayerMember,
} from '../../nodes/PoseLayer';
import { wirePoseTimes } from '../../nodes/RetargetClip';
import type { PosedSkeletonValue, Quat, Vec3 } from '../../nodes/types';
import { edgeTarget, type GraphNodeLike } from './graphNodes';
import { poseLayerChain } from './poseChain';

/** Which of the wire's poses become keys (Houdini's MotionClip thinning; Blender's frame step). */
export type BakePoses =
  | { readonly kind: 'every' }
  | { readonly kind: 'nth'; readonly n: number }
  | { readonly kind: 'times'; readonly times: readonly number[] };

/** How the baked keys interpolate: Blender's LINEAR, or Houdini's constant. */
export type BakeInterpolation = 'linear' | 'constant';

export interface BakePoseArgs {
  /** The armature Object whose chain is baked. */
  readonly object: string;
  /** A layer of the chain whose output is baked (it and everything below fold in); absent = the source. */
  readonly at?: string;
  readonly poses: BakePoses;
  readonly interpolation: BakeInterpolation;
  /** The id the baked layer takes. */
  readonly layerId: string;
}

export interface BakeReport {
  readonly layer: string;
  /** The seconds keyed, in order. */
  readonly times: readonly number[];
  readonly bones: number;
  /** The layers folded into the keys, now muted. */
  readonly muted: readonly string[];
  /** The computed source the chain read before the bake: no longer wired into it, still in the graph.
   *  Null when the chain already stood on the rest pose. */
  readonly detached: { readonly node: string; readonly socket: string } | null;
}

export type BakeResult =
  | { readonly ok: true; readonly ops: readonly Op[]; readonly report: BakeReport }
  | { readonly ok: false; readonly reason: string };

/** What the bake is called wherever a director meets it: the inspector's button, its undo entry,
 *  and the regeneration notice that points at it (#1230). One string, so none can name a control
 *  the others renamed. */
export const BAKE_POSE_LABEL = 'bake motion to keys';

/** The id a bake of `objectId` takes by default. */
export function bakedLayerIdFor(objectId: string): string {
  return `${objectId}_baked_pose`;
}

/** A layer id not yet in the graph, from the default on (`_2`, `_3`, …). */
export function freeBakedLayerId(state: DagState, objectId: string): string {
  const base = bakedLayerIdFor(objectId);
  if (!state.nodes[base]) return base;
  for (let i = 2; ; i++) if (!state.nodes[`${base}_${i}`]) return `${base}_${i}`;
}

const asGraph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

/**
 * The computed source an armature Object's pose chain stands on — a retarget's `posed`, a clip's
 * `pose` — or null when nothing poses it or it stands on its skeleton's rest pose (its motion is keys
 * already). What a bake of the source reads, and what decides whether one is offered.
 */
export function computedSourceOf(
  state: DagState,
  objectId: string,
): { readonly node: string; readonly socket: string } | null {
  const source = poseLayerChain(asGraph(state), objectId).source;
  if (source === null || state.nodes[source.node]?.type === 'Skeleton') return null;
  return source;
}

/** The wire's pose times to key, in seconds, sorted and distinct; or why there are none. */
export function bakeTimes(
  wire: PosedSkeletonValue,
  poses: BakePoses,
): { ok: true; times: number[] } | { ok: false; reason: string } {
  let times: number[];
  if (poses.kind === 'times') {
    times = [...new Set(poses.times)].sort((a, b) => a - b);
  } else {
    const range = wire.clip;
    if (!range) {
      return {
        ok: false,
        reason: 'the motion has no range to take its poses from: name the times',
      };
    }
    const every = wirePoseTimes(range).map((t) => range.start + t);
    if (poses.kind === 'every') times = every;
    else {
      // Every Nth pose from the first, and the last always (Houdini's "Include Range Start: Always").
      times = every.filter((_, i) => i % poses.n === 0);
      const last = every[every.length - 1];
      if (times[times.length - 1] !== last) times.push(last);
    }
  }
  if (times.length === 0) return { ok: false, reason: 'no times to key' };
  if (times.some((t) => !Number.isFinite(t) || t < 0)) {
    return { ok: false, reason: 'a key time must be a finite number of seconds, 0 or more' };
  }
  return { ok: true, times };
}

/**
 * Bake the wire at one point of an armature Object's pose chain into an override layer at the bottom
 * of that chain, and detach what the chain read before. One atomic step: undo restores the edge, the
 * mutes and removes the layer.
 */
export function bakePose(state: DagState, args: BakePoseArgs): BakeResult {
  const object = state.nodes[args.object];
  if (!object || object.type !== 'Object') {
    return { ok: false, reason: `“${args.object}” is not an Object` };
  }
  const skeletonId = edgeTarget(asGraph(state)[args.object], 'data');
  if (!skeletonId || state.nodes[skeletonId]?.type !== 'Skeleton') {
    return { ok: false, reason: `“${args.object}” is not an armature: its data is not a Skeleton` };
  }
  if (state.nodes[args.layerId]) {
    return {
      ok: false,
      reason: `“${args.layerId}” is taken; bake into “${freeBakedLayerId(state, args.object)}”`,
    };
  }
  const chain = poseLayerChain(asGraph(state), args.object);
  if (chain.source === null) return { ok: false, reason: `nothing poses “${args.object}”` };

  // The wire point, and the layers that fold into it.
  let point: { node: string; socket: string };
  let folded: string[];
  if (args.at !== undefined) {
    const index = chain.layers.indexOf(args.at);
    if (index < 0) {
      return { ok: false, reason: `“${args.at}” is not a pose layer under “${args.object}”` };
    }
    point = { node: args.at, socket: 'out' };
    folded = chain.layers.slice(index);
  } else {
    const computed = computedSourceOf(state, args.object);
    if (computed === null) {
      return {
        ok: false,
        reason:
          `“${args.object}” plays keys already (its layers on the rest pose): ` +
          'bake a layer to fold the layers under it into one',
      };
    }
    point = computed;
    folded = [];
  }

  let wire: PosedSkeletonValue | undefined;
  try {
    wire = evaluate(state, point.node, { socket: point.socket }).value as
      | PosedSkeletonValue
      | undefined;
  } catch (e) {
    return { ok: false, reason: `the motion could not be evaluated: ${(e as Error).message}` };
  }
  if (wire?.kind !== 'PosedSkeleton' || wire.skeleton.bones.length === 0) {
    return { ok: false, reason: 'there is no posed skeleton at that point of the chain' };
  }
  const timed = bakeTimes(wire, args.poses);
  if (!timed.ok) return timed;
  const { times } = timed;

  const params = bakedLayerParams(wire, times, args.interpolation);
  const bones = wire.skeleton.bones;

  const bottom = chain.layers[chain.layers.length - 1] ?? args.object;
  const detached = computedSourceOf(state, args.object);
  const ops: Op[] = [
    { type: 'addNode', nodeId: args.layerId, nodeType: 'PoseLayer', params },
    {
      type: 'connect',
      from: { node: skeletonId, socket: 'pose' },
      to: { node: args.layerId, socket: 'pose' },
    },
    {
      type: 'connect',
      from: { node: args.layerId, socket: 'out' },
      to: { node: bottom, socket: 'pose' },
      replace: true,
    },
  ];
  const muted: string[] = [];
  for (const id of folded) {
    // A layer of the chain is a `PoseLayer` by the walk's construction.
    if ((state.nodes[id].params as PoseLayerParams).mute === true) continue;
    ops.push({ type: 'setParam', nodeId: id, paramPath: 'mute', value: true });
    muted.push(id);
  }
  return {
    ok: true,
    ops,
    report: { layer: args.layerId, times, bones: bones.length, muted, detached },
  };
}

/**
 * The baked layer's params: an override layer with every bone of the wire as a quaternion member, and a
 * position, a quaternion and a scale channel per bone keyed at `times` from the wire's own sample.
 */
export function bakedLayerParams(
  wire: PosedSkeletonValue,
  times: readonly number[],
  easing: BakeInterpolation,
): PoseLayerParams {
  const bones = wire.skeleton.bones.map((b) => b.name);
  const position: { time: number; value: Vec3; easing: BakeInterpolation }[][] = bones.map(
    () => [],
  );
  const rotation: { time: number; value: Quat; easing: BakeInterpolation }[][] = bones.map(
    () => [],
  );
  const scale: { time: number; value: Vec3; easing: BakeInterpolation }[][] = bones.map(() => []);
  for (const time of times) {
    const poses = wire.sample(time);
    bones.forEach((_, i) => {
      const pose = poses[i];
      if (!pose) return;
      // Each quaternion on the previous one's side of the sphere, so the keys read as one continuous
      // curve (Blender's `make_compatible`, `anim_utils.py:521-531`).
      const before = rotation[i][rotation[i].length - 1]?.value;
      const q = pose.quaternion;
      const flip = before !== undefined && dot(before, q) < 0;
      position[i].push({ time, value: [...pose.position] as Vec3, easing });
      const value: Quat = flip ? [-q[0], -q[1], -q[2], -q[3]] : [q[0], q[1], q[2], q[3]];
      rotation[i].push({ time, value, easing });
      scale[i].push({ time, value: [...pose.scale] as Vec3, easing });
    });
  }
  const members: PoseLayerMember[] = bones.map((bone) => ({ bone, rotationMode: 'quaternion' }));
  const channels = bones.flatMap((bone, i) => [
    { bone, component: 'position', keyframes: position[i] },
    { bone, component: 'quaternion', keyframes: rotation[i] },
    { bone, component: 'scale', keyframes: scale[i] },
  ]) as PoseLayerChannel[];
  return PoseLayerParams.parse({
    name: wire.clip?.name ?? 'baked',
    mode: 'override',
    members,
    channels,
  });
}

function dot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}
