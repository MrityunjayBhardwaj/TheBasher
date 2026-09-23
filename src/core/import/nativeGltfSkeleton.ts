// #393 (step 1) — a skinned glTF's joints read into a native `Skeleton` and the clip on them into an
// `AnimationClip`, the shape the FBX and BVH roads already land (`fbxImportChain.ts`,
// `bvhImportChain.ts`). The joints stop being empties: a bone is data of the skeleton, not a node
// of the scene.
//
// ── WHICH NODES ARE BONES ───────────────────────────────────────────────────────────────────────
//
// The format declares them, not the mesh: Blender's glTF importer makes a bone of every joint AND of
// every node between a joint and the joints' deepest common ancestor, and the node above that is
// where the armature stands (`io_scene_gltf2/blender/imp/vnode.py`, `mark_bones_and_armas`,
// Blender 5.1.1). A skin lists only the nodes it weights, so reading the bone set off the skin alone
// would drop a node the chain passes through and misplace every bone below it (its TRS is local to
// the parent it names).
//
// ── ONE SPELLING ON BOTH SIDES ──────────────────────────────────────────────────────────────────
//
// The skin joins the skeleton BY NAME (Blender `armature_deform.cc:330-333`; Houdini Joint Deform),
// so the mesh's `vertexGroups` and the skeleton's bone names must be the same strings, and ONE
// function writes both: {@link nativeBoneNames}. It sanitises each name with `sanitizeBoneName`
// (three reserves `[].:/` in a track path) and then makes it unique with `.001`, `.002`, … in the
// order Blender creates bones (depth-first from the armature, `imp/node.py`, `create_bones`) —
// Blender dedups the bone as it creates it and names the vertex group after the bone it got
// (`imp/mesh.py:362`), so both sides carry the suffix. An unnamed node is `Node_<index>`, Blender's
// fallback (`vnode.py:113`).
//
// ── THE REST IS THE FILE'S NODE TRS ─────────────────────────────────────────────────────────────
//
// Each bone rests at its node's own translation, rotation and scale, relative to its parent bone.
// Blender by default GUESSES a bind pose from the inverse bind matrices instead
// (`guess_original_bind_pose`, `vnode.py:489-535`); on every skinned file in the repo the two agree
// exactly (the recomputed inverses equal the file's), so the difference cannot show on them.
//
// ── WHAT THE CLIP LOSES, AND WHAT IS REFUSED SO THAT IT LOSES NOTHING SILENTLY ──────────────────
//
// An `AnimationClip` key holds a bone's position and XYZ euler rotation at one time, interpolated
// linearly. Keys are written at the union of the bone's own channel times, each channel sampled
// there by the ONE channel sampler (`sampleQuatKeyframes` / `sampleVec3Keyframes`), so at every key
// the pose is the file's exactly. What a clip cannot hold is refused whole, by name: a bone channel
// that is not LINEAR (a step or a cubic between two keys is not a straight line), and a bone's
// scale (a clip key has no scale). Between two keys a rotation about more than one axis follows the
// euler lerp rather than the spec's slerp — the FBX road's clip does the same. Measured 0° on every
// skinned fixture we hold and 24.8° at the middle of a 120° two-axis segment (#1202).
//
// REF: io_scene_gltf2/blender/imp/{vnode,node,mesh}.py (Blender 5.1.1, bundled);
//      ref/GROUND_TRUTH_HOUDINI_KINEFX_SKINNING.md §8; src/core/import/skeletonObject.ts (the
//      standing Object); issues #393, #1196, #1197.

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { AnimationKeyframe, BoneSpec, Quat, Vec3 } from '../../nodes/types';
import { sampleQuatKeyframes, sampleVec3Keyframes } from '../../nodes/keyframeInterp';
import type { ClipChannel } from './nativeGltfClip';
import type { NativeImportRefusal } from './nativeGltfImport';
import { continuousEuler, quaternionToEulerVec3, sanitizeBoneName } from './threeAdapter';
import type { GltfJson } from './glb';

/** The slice of a glTF document the skeleton reader looks at. */
export type SkeletonGltfJson = Pick<GltfJson, 'nodes' | 'skins'>;

/** Every refusal on this road names the issue that will bring its case across. */
const ISSUE = '#393';

export interface NativeSkeleton {
  /** The glTF node each bone is, in bone order: parents before children, Blender's creation order. */
  readonly boneNodes: readonly number[];
  readonly bones: readonly BoneSpec[];
  /** Bone names in `skin.joints` order — what `JOINTS_0` indexes, and what the mesh stores. */
  readonly vertexGroups: readonly string[];
  /** The glTF node the skeleton stands under, or `null` when that is the file's root. */
  readonly armatureNode: number | null;
}

/**
 * The name each bone is known by, on the skeleton AND in every skinned mesh's `vertexGroups` —
 * THE one spelling of a joint on this road. `sanitizeBoneName`, then `.001`, `.002`, … for a name
 * already taken, in the order given (bone order).
 */
export function nativeBoneNames(json: SkeletonGltfJson, boneNodes: readonly number[]): string[] {
  const taken = new Set<string>();
  return boneNodes.map((node) => {
    const base = sanitizeBoneName(json.nodes[node].name || `Node_${node}`);
    let name = base;
    for (let n = 1; taken.has(name); n++) name = `${base}.${String(n).padStart(3, '0')}`;
    taken.add(name);
    return name;
  });
}

/** The parent of each node, by the `children` lists. A node no one names is a root. */
function parentsOf(json: SkeletonGltfJson): Map<number, number> {
  const parent = new Map<number, number>();
  json.nodes.forEach((node, i) => {
    for (const child of node.children ?? []) parent.set(child, i);
  });
  return parent;
}

/** The nodes from the root down to `node`, inclusive. */
function pathFromRoot(parent: ReadonlyMap<number, number>, node: number): number[] {
  const path: number[] = [];
  for (let at: number | undefined = node; at !== undefined; at = parent.get(at)) path.push(at);
  return path.reverse();
}

/**
 * The file's skin read as a skeleton, `null` when the file has no skin, or the refusal naming why
 * it cannot be one yet.
 */
export function readNativeSkeleton(
  json: SkeletonGltfJson,
): NativeSkeleton | NativeImportRefusal | null {
  const skins = json.skins ?? [];
  if (skins.length === 0) return null;
  if (skins.length > 1) {
    return {
      refused: `it has ${skins.length} skins, and a native import builds one skeleton`,
      issue: ISSUE,
    };
  }
  const skin = skins[0];
  if (skin.joints.length === 0) return { refused: 'its skin lists no joints', issue: ISSUE };
  const parent = parentsOf(json);

  // The armature: the deepest common ancestor of the joints (and the declared skeleton root), or
  // its parent when that ancestor is itself a joint — `vnode.py`, `mark_bones_and_armas`. `null`
  // stands for the file's root, above every scene root.
  const tracked = [...skin.joints, ...(skin.skeleton === undefined ? [] : [skin.skeleton])];
  let common: (number | null)[] = [null, ...pathFromRoot(parent, tracked[0])];
  for (const node of tracked.slice(1)) {
    const path = [null, ...pathFromRoot(parent, node)];
    let k = 0;
    while (k < common.length && k < path.length && common[k] === path[k]) k++;
    common = common.slice(0, k);
  }
  let armatureNode = common[common.length - 1];
  if (armatureNode !== null && skin.joints.includes(armatureNode)) {
    armatureNode = parent.get(armatureNode) ?? null;
  }

  // Every node from a joint up to (not including) the armature is a bone.
  const isBone = new Set<number>();
  for (const joint of skin.joints) {
    for (let at: number | undefined = joint; at !== undefined && at !== armatureNode; ) {
      isBone.add(at);
      at = parent.get(at);
    }
  }

  // Bone order: depth-first from the armature's children, through bones only — `create_bones`.
  const topLevel =
    armatureNode === null
      ? json.nodes.map((_, i) => i).filter((i) => !parent.has(i))
      : (json.nodes[armatureNode].children ?? []);
  const boneNodes: number[] = [];
  const visit = (node: number): void => {
    if (!isBone.has(node)) return;
    boneNodes.push(node);
    for (const child of json.nodes[node].children ?? []) visit(child);
  };
  for (const node of topLevel) visit(node);

  // A bone that is also a mesh, or a non-bone hanging under a bone, would need an Object parented
  // to a bone, which the native model has no edge for.
  for (const node of boneNodes) {
    if (typeof json.nodes[node].mesh === 'number') {
      return {
        refused: `node ${node} is both a bone and a mesh, which the native model cannot hold`,
        issue: ISSUE,
      };
    }
    const underBone = (json.nodes[node].children ?? []).find((child) => !isBone.has(child));
    if (underBone !== undefined) {
      return {
        refused: `node ${underBone} hangs under bone node ${node}, and parenting to a bone is not native yet`,
        issue: ISSUE,
      };
    }
  }

  const names = nativeBoneNames(json, boneNodes);
  const boneOf = new Map(boneNodes.map((node, i) => [node, i]));
  const bones = boneNodes.map((node, i): BoneSpec => {
    const rest = restOf(json.nodes[node]);
    const up = parent.get(node);
    const [rx, ry, rz] = quaternionToEulerVec3(new Quaternion(...rest.quaternion));
    return {
      name: names[i],
      parent: up === undefined ? -1 : (boneOf.get(up) ?? -1),
      position: rest.position,
      // `+ 0` writes an identity rest as 0, not the -0 the euler conversion can return.
      rotation: [rx + 0, ry + 0, rz + 0],
      ...(rest.scale.every((s) => s === 1) ? {} : { scale: rest.scale }),
    };
  });
  return {
    boneNodes,
    bones,
    vertexGroups: skin.joints.map((joint) => names[boneOf.get(joint)!]),
    armatureNode,
  };
}

/** A node's own TRS; a `matrix` node decomposed (glTF forbids shear, so TRS is exact). */
function restOf(node: SkeletonGltfJson['nodes'][number]): {
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
} {
  if (node.matrix) {
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    new Matrix4().fromArray(node.matrix).decompose(position, quaternion, scale);
    return {
      position: position.toArray(),
      quaternion: quaternion.toArray() as Quat,
      scale: scale.toArray(),
    };
  }
  return {
    position: (node.translation ?? [0, 0, 0]) as Vec3,
    quaternion: (node.rotation ?? [0, 0, 0, 1]) as Quat,
    scale: (node.scale ?? [1, 1, 1]) as Vec3,
  };
}

/**
 * The clip's channels on bones as `AnimationClip` keys, or the refusal naming a channel a clip
 * cannot hold. Channels on other nodes are not this function's; the caller keeps them.
 */
export function nativeSkeletonClip(
  skeleton: NativeSkeleton,
  channels: readonly ClipChannel[],
  json: SkeletonGltfJson,
): { keyframes: AnimationKeyframe[]; duration: number } | NativeImportRefusal {
  const boneOf = new Map(skeleton.boneNodes.map((node, i) => [node, i]));
  const perBone = new Map<number, { translation?: ClipChannel; rotation?: ClipChannel }>();
  let duration = 0;
  for (const channel of channels) {
    const bone = boneOf.get(channel.node);
    if (bone === undefined) continue;
    const name = skeleton.bones[bone].name;
    if (channel.path === 'scale') {
      return {
        refused: `its clip scales bone ${name}, and a clip key holds no scale`,
        issue: ISSUE,
      };
    }
    const stepped = channel.keyframes.find((k) => k.easing !== 'linear');
    if (stepped !== undefined) {
      return {
        refused: `its clip moves bone ${name} by ${stepped.easing === 'constant' ? 'STEP' : 'CUBICSPLINE'}, and a clip interpolates linearly`,
        issue: ISSUE,
      };
    }
    const entry = perBone.get(bone) ?? {};
    entry[channel.path] = channel;
    perBone.set(bone, entry);
    duration = Math.max(duration, ...channel.keyframes.map((k) => k.time));
  }

  const keyframes: AnimationKeyframe[] = [];
  for (const [bone, { translation, rotation }] of perBone) {
    const rest = restOf(json.nodes[skeleton.boneNodes[bone]]);
    const times = [
      ...new Set(
        [...(translation?.keyframes ?? []), ...(rotation?.keyframes ?? [])].map((k) => k.time),
      ),
    ].sort((a, b) => a - b);
    let previous: Vec3 | null = null;
    for (const time of times) {
      const q =
        rotation?.path === 'rotation'
          ? sampleQuatKeyframes(rotation.keyframes, time)
          : rest.quaternion;
      const euler = continuousEuler(quaternionToEulerVec3(new Quaternion(...q)), previous);
      previous = euler;
      keyframes.push({
        bone,
        time,
        position:
          translation?.path === 'translation'
            ? sampleVec3Keyframes(translation.keyframes, time)
            : rest.position,
        rotation: euler,
      });
    }
  }
  keyframes.sort((a, b) => a.time - b.time || a.bone - b.bone);
  return { keyframes, duration };
}
