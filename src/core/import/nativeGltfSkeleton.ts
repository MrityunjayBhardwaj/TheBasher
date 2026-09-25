// #393 (step 1) — a skinned glTF's joints read into a native `Skeleton`, and the clip on them into
// keys on the armature's base pose layer (#1211). The joints stop being empties: a bone is data of the skeleton, not a node
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
// ── THE MOTION IS KEYS ON THE BASE POSE LAYER, AS THE FILE WROTE THEM (#1211, #1212) ─────────────
//
// Each bone channel becomes a channel of the armature's base `PoseLayer` (step 4 of "Bones as
// Channels", #1233): translation → `position`, rotation → `quaternion`, scale → `scale`, each with
// the file's own keys, times, interpolation and handles — STEP as constant, CUBICSPLINE as bézier
// handles carrying the file's tangents, LINEAR rotation slerped, as `readNativeClip` reads every
// glTF channel. Each keyed bone is a member in quaternion mode, as the file stores rotations. Nothing
// is refused or dropped: Blender keeps every bone channel as the pose bone's F-curve, a scale that
// holds the rest included (`io_scene_gltf2/blender/imp/animation_node.py`). A component the file does
// not key rests where the skeleton's rest pose holds it.
//
// REF: io_scene_gltf2/blender/imp/{vnode,node,mesh}.py (Blender 5.1.1, bundled);
//      ref/GROUND_TRUTH_HOUDINI_KINEFX_SKINNING.md §8; src/core/import/skeletonObject.ts (the
//      standing Object); issues #393, #1196, #1197.

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BoneSpec, Quat, Vec3 } from '../../nodes/types';
import type { PoseLayerChannel, PoseLayerMember } from '../../nodes/PoseLayer';
import type { ClipChannel } from './nativeGltfClip';
import type { NativeImportRefusal } from './nativeGltfImport';
import { quaternionToEulerVec3, sanitizeBoneName } from './threeAdapter';
import type { GltfJson } from './glb';

/** The slice of a glTF document the skeleton reader looks at. */
export type SkeletonGltfJson = Pick<GltfJson, 'nodes' | 'skins' | 'animations'>;

/** Every refusal on this road names the issue that will bring its case across. */
const ISSUE = '#393';

export interface NativeSkeleton {
  /** The glTF node each bone is, in bone order: parents before children, Blender's creation order. */
  readonly boneNodes: readonly number[];
  readonly bones: readonly BoneSpec[];
  /** The glTF node the skeleton stands under, or `null` when that is the file's root. */
  readonly armatureNode: number | null;
}

/** Every armature in the file, and which one each skin binds to. */
export interface NativeSkeletons {
  /** One skeleton per armature, in the order a depth-first walk of the file meets them. */
  readonly skeletons: readonly NativeSkeleton[];
  /**
   * Per skin, in `json.skins` order: the skeleton it binds to (its first joint's, as Blender
   * picks — `vnode.py`, `move_skinned_meshes`), and its bone names in `skin.joints` order — what
   * `JOINTS_0` indexes, and what the mesh stores as `vertexGroups`.
   */
  readonly skins: readonly {
    readonly skeleton: number;
    readonly vertexGroups: readonly string[];
  }[];
}

/**
 * The name each bone is known by, on the skeleton AND in every skinned mesh's `vertexGroups` —
 * THE one spelling of a joint on this road. `sanitizeBoneName`, then `.001`, `.002`, … for a name
 * already taken, in the order given (bone order). Unique within one skeleton, as Blender's names
 * are within one armature: two armatures may each have a `Bone0`.
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

/** The file's root, above every scene root — where an armature stands when no node holds it. */
const FILE_ROOT = -1;

/**
 * The file's skins read as skeletons, `null` when the file has no skin, or the refusal naming why
 * it cannot be read yet.
 *
 * ── ONE SKELETON PER ARMATURE, AND AN ARMATURE IS A NODE, NOT A SKIN (#1208) ────────────────────
 *
 * Blender's importer, `vnode.py` `mark_bones_and_armas` (5.1.1), in order: for EACH skin, the
 * armature is the deepest common ancestor of its joints (and its declared skeleton root), or that
 * node's parent when it is itself a joint; the node becomes an armature unless a skin before it
 * already made it a bone; then every node from each joint up to that armature becomes a bone — which
 * can turn an armature an earlier skin chose into a bone of a later one. Finally a depth-first walk
 * gives each bone the nearest armature above it. So two skins over the same joints (a body and its
 * eyes) share ONE armature, and skins under different ancestors get one each. Measured on
 * `two-skinned-bars.glb`: two armature Objects, each mesh deformed by its own, both named
 * `Bone0`/`Bone1` (`ref/probes/blender-native-character/q1208_two_skins_oracle.py`).
 */
export function readNativeSkeletons(
  json: SkeletonGltfJson,
): NativeSkeletons | NativeImportRefusal | null {
  const skins = json.skins ?? [];
  if (skins.length === 0) return null;
  const parent = parentsOf(json);
  const up = (node: number): number => parent.get(node) ?? FILE_ROOT;

  const kind = new Map<number, 'bone' | 'armature'>();
  for (const [index, skin] of skins.entries()) {
    if (skin.joints.length === 0) {
      return { refused: `its skin ${index} lists no joints`, issue: ISSUE };
    }
    const tracked = [...skin.joints, ...(skin.skeleton === undefined ? [] : [skin.skeleton])];
    let common = [FILE_ROOT, ...pathFromRoot(parent, tracked[0])];
    for (const node of tracked.slice(1)) {
      const path = [FILE_ROOT, ...pathFromRoot(parent, node)];
      let k = 0;
      while (k < common.length && k < path.length && common[k] === path[k]) k++;
      common = common.slice(0, k);
    }
    let armature = common[common.length - 1];
    if (armature !== FILE_ROOT && skin.joints.includes(armature)) armature = up(armature);
    if (kind.get(armature) !== 'bone') kind.set(armature, 'armature');
    for (const joint of skin.joints) {
      for (let at = joint; at !== armature; at = up(at)) kind.set(at, 'bone');
    }
  }

  // Each bone's armature: the nearest one above it, by a depth-first walk from the file root.
  const armatureOf = new Map<number, number>();
  const armatures: number[] = [];
  const topLevel = json.nodes.map((_, i) => i).filter((i) => !parent.has(i));
  const walk = (node: number, current: number | null): void => {
    const k = kind.get(node);
    if (k === 'armature') current = node;
    else if (k === 'bone' && current !== null) {
      armatureOf.set(node, current);
      if (!armatures.includes(current)) armatures.push(current);
    } else current = null;
    for (const child of json.nodes[node].children ?? []) walk(child, current);
  };
  for (const node of topLevel) walk(node, kind.get(FILE_ROOT) === 'armature' ? FILE_ROOT : null);

  // A bone that is also a mesh would need its mesh moved onto a child of the bone (Blender's
  // `fixup_multitype_nodes`, #1209). A mesh hanging under a bone comes across parented to that bone
  // (#1210); an EMPTY under a bone does not yet (#1219) — nor does a skinned node the reader would
  // leave behind as one (it has children, or is animated: `vnode.py:349-408`).
  for (const node of armatureOf.keys()) {
    if (typeof json.nodes[node].mesh === 'number') {
      return {
        refused: `node ${node} is both a bone and a mesh, which the native model cannot hold`,
        issue: '#1209',
      };
    }
    for (const child of json.nodes[node].children ?? []) {
      if (armatureOf.has(child)) continue;
      const under = json.nodes[child];
      const leftAsEmpty = typeof under.skin === 'number' && leftBehindAsEmpty(json, child);
      if (typeof under.mesh !== 'number' || leftAsEmpty) {
        return {
          refused: `node ${child} is an empty under bone node ${node}, and an empty cannot be parented to a bone yet`,
          issue: '#1219',
        };
      }
    }
  }

  const skeletons = armatures.map((armature) =>
    skeletonUnder(json, parent, armature, (node) => armatureOf.get(node) === armature),
  );
  const skeletonOfNode = new Map<number, number>();
  skeletons.forEach((skeleton, i) => skeleton.boneNodes.forEach((n) => skeletonOfNode.set(n, i)));

  const skinsOut: { skeleton: number; vertexGroups: string[] }[] = [];
  for (const [index, skin] of skins.entries()) {
    const skeleton = skeletonOfNode.get(skin.joints[0])!;
    const stray = skin.joints.find((joint) => skeletonOfNode.get(joint) !== skeleton);
    if (stray !== undefined) {
      return {
        refused: `skin ${index} weights joints under two armatures (node ${stray} is not under its first joint's)`,
        issue: ISSUE,
      };
    }
    const { boneNodes, bones } = skeletons[skeleton];
    skinsOut.push({
      skeleton,
      vertexGroups: skin.joints.map((joint) => bones[boneNodes.indexOf(joint)].name),
    });
  }
  return { skeletons, skins: skinsOut };
}

/**
 * Whether a skinned node that is not its armature's node is LEFT BEHIND as an empty, with its mesh
 * moved to a new object under the armature: when anything else rides on it — it has children, or
 * it is animated (Blender `vnode.py:349-408`). Otherwise the node itself moves. THE one answer: the
 * build makes the empty by it (`nativeGltfImport.ts`), and the refusal of an empty under a bone
 * (#1219) reads it too, so the two cannot disagree about which nodes become empties (#1221).
 */
export function leftBehindAsEmpty(json: SkeletonGltfJson, node: number): boolean {
  return (
    (json.nodes[node].children?.length ?? 0) > 0 ||
    (json.animations ?? []).some((a) => a.channels.some((c) => c.target.node === node))
  );
}

/** One armature's skeleton: its bones in Blender's creation order, named, at their node rests. */
function skeletonUnder(
  json: SkeletonGltfJson,
  parent: ReadonlyMap<number, number>,
  armature: number,
  isBone: (node: number) => boolean,
): NativeSkeleton {
  // Bone order: depth-first from the armature's children, through bones only — `create_bones`.
  const topLevel =
    armature === FILE_ROOT
      ? json.nodes.map((_, i) => i).filter((i) => !parent.has(i))
      : (json.nodes[armature].children ?? []);
  const boneNodes: number[] = [];
  const visit = (node: number): void => {
    if (!isBone(node)) return;
    boneNodes.push(node);
    for (const child of json.nodes[node].children ?? []) visit(child);
  };
  for (const node of topLevel) visit(node);

  const names = nativeBoneNames(json, boneNodes);
  const boneOf = new Map(boneNodes.map((node, i) => [node, i]));
  const bones = boneNodes.map((node, i): BoneSpec => {
    const rest = restOf(json.nodes[node]);
    const above = parent.get(node);
    const [rx, ry, rz] = quaternionToEulerVec3(new Quaternion(...rest.quaternion));
    return {
      name: names[i],
      parent: above === undefined ? -1 : (boneOf.get(above) ?? -1),
      position: rest.position,
      // `+ 0` writes an identity rest as 0, not the -0 the euler conversion can return.
      rotation: [rx + 0, ry + 0, rz + 0],
      ...(rest.scale.every((v) => v === 1) ? {} : { scale: rest.scale }),
    };
  });
  return { boneNodes, bones, armatureNode: armature === FILE_ROOT ? null : armature };
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
 * #1211 — the clip's channels on this skeleton's bones as a base pose layer's members and channels,
 * in the file's channel order. Channels on other nodes are not this function's; the caller keeps
 * them. Every keyed bone is a member in quaternion mode; a channel is `{bone, component, keyframes}`
 * with the file's keys as `readNativeClip` read them. No provenance: the keys are the character's.
 */
export function nativeSkeletonLayer(
  skeleton: NativeSkeleton,
  channels: readonly ClipChannel[],
): { members: PoseLayerMember[]; channels: PoseLayerChannel[] } {
  const boneOf = new Map(skeleton.boneNodes.map((node, i) => [node, i]));
  const keyed = new Set<string>();
  const out: PoseLayerChannel[] = [];
  for (const channel of channels) {
    const index = boneOf.get(channel.node);
    if (index === undefined) continue;
    const bone = skeleton.bones[index].name;
    keyed.add(bone);
    out.push({
      bone,
      component: COMPONENT[channel.path],
      keyframes: channel.keyframes,
    } as PoseLayerChannel);
  }
  // Members in bone order, so a layer reads the same whatever order the file lists its channels.
  const members: PoseLayerMember[] = skeleton.bones
    .filter((b) => keyed.has(b.name))
    .map((b) => ({ bone: b.name, rotationMode: 'quaternion' }));
  return { members, channels: out };
}

/** A glTF channel path as the pose layer component it keys. */
const COMPONENT = {
  translation: 'position',
  rotation: 'quaternion',
  scale: 'scale',
} as const satisfies Record<ClipChannel['path'], PoseLayerChannel['component']>;
