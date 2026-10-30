// rigIndex — a bone found by name is a lookup, not a crawl through the scene (#1732).
//
// WHY THIS EXISTS. A Track-To aimed at a character's bone (the camera on `hips_00`) asked
// `gltfNodeWorldPosition` for the bone on every frame, and each call walked the graph out from the
// node, sorted what it reached, linear-searched the rig's bone names, re-evaluated the skeleton,
// resolved the armature's world, posed every bone and placed each one in the world, then searched
// that list for the one it wanted: 2.1 ms a call on the alley scene (426 nodes).
//
// Blender fetches a bone by hash (`BKE_pose_channel_find_name` → `BLI_ghash_lookup(pose->chanhash,
// name)`, blenkernel/intern/action.cc), keeps each bone's posed matrix in armature space after
// evaluation (`bPoseChannel.pose_mat`, makesdna/DNA_action_types.h), and a constraint aimed at a
// bone does one lookup and one multiply, `object_to_world · pose_mat` (blenkernel/intern/
// constraint.cc). This module is that shape:
//
//   - Kept per graph (per `state.nodes` record, and per evaluator content epoch, since a clip
//     loaded later changes what the skeleton evaluates to without an edit): which character asset
//     or armatures a node stands for, and per armature its rest bones, its bone index by name and its pose.
//   - `armaturePoseAt(state, armatureId, seconds)`: every bone's posed matrix in armature space, as
//     16 numbers per bone (Blender's `pose_mat`), computed once per armature per time and kept until
//     another time is asked. Today it poses the rig itself, by the composer the armature helper
//     draws with (`posedWorldMatrices`); the per-frame table (#1730) will answer it instead.
//   - `armatureWorldAt`: the armature Object's world at that time, kept the same way.
//
// A bone's world position is then `world · pose_mat[i]`'s translation: no evaluate, no scene walk,
// no posing, no search, once the armature has been posed for that time.
//
// REF: issue #1732; src/app/gltfNodeWorld.ts (the reader); src/viewport/boneShape.ts
//      (`posedWorldMatrices`, `boneWorldMatrices`); src/app/characterParts.ts (`nativeRigsOf`).

import * as THREE from 'three';
import { evaluate, evaluatorContentEpoch, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import { armaturePoseOf } from '../nodes/bonePose';
import { samplePose } from '../nodes/poseSample';
import type { BoneSpec, ObjectValue, PosedSkeletonValue } from '../nodes/types';
import { boneWorldMatrices, posedWorldMatrices } from '../viewport/boneShape';
import { characterAssetOf, nativeRigsOf } from './characterParts';
import { resolveWorldTransform } from './resolveWorldTransform';
import { useTransientEditStore } from './stores/transientEditStore';

const FRAME_0: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** An armature Object as the band draws it: its rest bones, their index by name, and its pose. */
export interface Armature {
  readonly objectId: string;
  readonly bones: readonly BoneSpec[];
  /** Bone name → index in `bones`, the first bone of a name winning (as a search would). */
  readonly boneIndex: ReadonlyMap<string, number>;
  readonly pose: PosedSkeletonValue | null;
  /** Its Object's world matrix at frame 0 — where it stands when a later time cannot be placed. */
  readonly restWorld: readonly number[];
}

/** An armature a node stands for, with the bone names its Skeleton declares. */
export interface RigEntry {
  readonly objectId: string;
  readonly boneNames: ReadonlySet<string>;
}

interface RigIndex {
  assetFor(nodeId: string): string | null;
  rigsFor(nodeId: string): readonly RigEntry[];
  armature(objectId: string, cache?: EvaluatorCache): Armature | null;
  /** Per armature: the last time it was posed and placed, and the answers. */
  readonly frames: Map<string, { pose?: Slot<Float64Array>; world?: WorldSlot }>;
}

interface Slot<T> {
  readonly seconds: number;
  readonly value: T;
}
interface WorldSlot extends Slot<readonly number[]> {
  readonly transients: unknown;
}

const indexCache = new WeakMap<DagState['nodes'], { epoch: number; index: RigIndex }>();

function rigIndexOf(state: DagState): RigIndex {
  const epoch = evaluatorContentEpoch();
  const hit = indexCache.get(state.nodes);
  if (hit && hit.epoch === epoch) return hit.index;
  const rigs = new Map<string, RigEntry[]>();
  const assets = new Map<string, string | null>();
  const armatures = new Map<string, Armature | null>();
  const index: RigIndex = {
    frames: new Map(),
    assetFor(nodeId) {
      if (!assets.has(nodeId)) assets.set(nodeId, characterAssetOf(state, nodeId));
      return assets.get(nodeId) ?? null;
    },
    rigsFor(nodeId) {
      let known = rigs.get(nodeId);
      if (!known) {
        known = nativeRigsOf(state, nodeId).map((r) => ({
          objectId: r.objectId,
          boneNames: new Set(r.boneNames),
        }));
        rigs.set(nodeId, known);
      }
      return known;
    },
    armature(objectId, cache) {
      if (!armatures.has(objectId)) armatures.set(objectId, readArmature(state, objectId, cache));
      return armatures.get(objectId) ?? null;
    },
  };
  indexCache.set(state.nodes, { epoch, index });
  return index;
}

/** The armature `objectId` draws — null when it draws none (no Skeleton, no bones, or not in the
 *  scene), the same cases the armature band and the old per-call read skip. */
function readArmature(state: DagState, objectId: string, cache?: EvaluatorCache): Armature | null {
  const node = state.nodes[objectId];
  const skeletonId = (node?.inputs?.data as { node?: string } | undefined)?.node;
  if (!skeletonId) return null;
  try {
    const data = evaluate(state, skeletonId, { cache, ctx: FRAME_0, socket: 'out' }).value as
      | { kind?: string; bones?: BoneSpec[] }
      | undefined;
    if (data?.kind !== 'Skeleton' || !data.bones?.length) return null;
    const rest = resolveWorldTransform(state, objectId, FRAME_0, cache);
    if (!rest) return null;
    const value = evaluate(state, objectId, { cache, ctx: FRAME_0 }).value as ObjectValue;
    const boneIndex = new Map<string, number>();
    data.bones.forEach((b, i) => {
      if (!boneIndex.has(b.name)) boneIndex.set(b.name, i);
    });
    return {
      objectId,
      bones: data.bones,
      boneIndex,
      pose: armaturePoseOf(value),
      restWorld: rest.matrix,
    };
  } catch {
    return null;
  }
}

/** The GltfAsset `nodeId` stands for (`characterAssetOf`, which walks everything upstream of the
 *  node), kept per graph. Null for a native character, whose bones are an armature's. */
export function characterAssetFor(state: DagState, nodeId: string): string | null {
  return rigIndexOf(state).assetFor(nodeId);
}

/** The armatures `nodeId` stands for (the armature Object itself, a mesh it deforms, or what holds
 *  either), in id order, each with its Skeleton's bone names. */
export function rigsFor(state: DagState, nodeId: string): readonly RigEntry[] {
  return rigIndexOf(state).rigsFor(nodeId);
}

/** The armature `objectId` draws, or null when it draws none. */
export function armatureOf(
  state: DagState,
  objectId: string,
  cache?: EvaluatorCache,
): Armature | null {
  return rigIndexOf(state).armature(objectId, cache);
}

/**
 * Every bone's posed matrix in armature space at `seconds` — Blender's `pose_mat` — as 16 numbers
 * per bone, column-major (three's `toArray`), in `bones` order. At rest when the armature has no
 * pose. Posed once per armature per time: asking again at the same time returns the same array.
 * Null when `armatureId` draws no armature.
 */
export function armaturePoseAt(
  state: DagState,
  armatureId: string,
  seconds: number,
  cache?: EvaluatorCache,
): Float64Array | null {
  const index = rigIndexOf(state);
  const arm = index.armature(armatureId, cache);
  if (!arm) return null;
  const frame = index.frames.get(armatureId) ?? {};
  if (frame.pose && frame.pose.seconds === seconds) return frame.pose.value;
  const mats = arm.pose
    ? posedWorldMatrices(arm.bones, samplePose(arm.pose, seconds))
    : boneWorldMatrices(arm.bones);
  const out = new Float64Array(mats.length * 16);
  mats.forEach((m, i) => out.set(m.elements, i * 16));
  index.frames.set(armatureId, { ...frame, pose: { seconds, value: out } });
  return out;
}

/** The armature Object's world matrix at `seconds`, kept per time like its pose (and per held
 *  edit, so a drag in progress is read where it is drawn). Its frame-0 world where that time
 *  cannot be placed, as `worldMatrixAt` answers; null when it draws no armature. */
export function armatureWorldAt(
  state: DagState,
  armatureId: string,
  seconds: number,
  cache?: EvaluatorCache,
): readonly number[] | null {
  const index = rigIndexOf(state);
  const arm = index.armature(armatureId, cache);
  if (!arm) return null;
  const transients = useTransientEditStore.getState().edits;
  const frame = index.frames.get(armatureId) ?? {};
  const kept = frame.world;
  if (kept && kept.seconds === seconds && kept.transients === transients) return kept.value;
  const ctx: EvalCtx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
  const value = resolveWorldTransform(state, armatureId, ctx, cache)?.matrix ?? arm.restWorld;
  index.frames.set(armatureId, { ...frame, world: { seconds, transients, value } });
  return value;
}

const _world = new THREE.Matrix4();
const _bone = new THREE.Matrix4();
const _head = new THREE.Vector3();

/**
 * The world position of bone `boneName`'s head on the armature `armatureId`, at `seconds`, posed
 * as it is drawn: one lookup and one multiply, `world · pose_mat[i]`. Null when there is no such
 * armature or bone.
 */
export function boneWorldHead(
  state: DagState,
  armatureId: string,
  boneName: string,
  seconds: number,
  cache?: EvaluatorCache,
): [number, number, number] | null {
  const arm = armatureOf(state, armatureId, cache);
  const i = arm?.boneIndex.get(boneName);
  if (i === undefined) return null;
  const pose = armaturePoseAt(state, armatureId, seconds, cache);
  const world = armatureWorldAt(state, armatureId, seconds, cache);
  if (!pose || !world) return null;
  _bone.fromArray(pose, i * 16);
  _head.setFromMatrixPosition(_world.fromArray(world).multiply(_bone));
  return [_head.x, _head.y, _head.z];
}
