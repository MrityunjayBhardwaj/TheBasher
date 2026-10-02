// Shared THREE → DAG-native projection. BVH and FBX import paths both
// produce THREE.Skeleton + THREE.AnimationClip pairs that need to be
// flattened into our POJO Skeleton/AnimationClip params.
//
// Extracted from bvh.ts when fbx.ts landed — second use crossed the
// dharana §4 threshold ("Wait for a second use"). Sole responsibility:
// translate THREE-side shapes into BoneSpec[] + timed poses (MotionPose[]).
//
// Conversions:
//   - Bone tree → BoneSpec[] with parent indices (DAG uses indices,
//     THREE uses parent references). A bone's rest rotation is XYZ Euler.
//   - Tracks → timed poses by bone name, quaternions read as quaternions
//     (#1432); a bone keyed on one property takes the other from its rest.
//
// The index + Euler key form these used to produce survives only as saved
// projects hold it, in `savedClipKeys.ts`.

import {
  AnimationClip,
  Bone,
  Euler,
  type Object3D,
  QuaternionKeyframeTrack,
  Quaternion,
  Skeleton,
  VectorKeyframeTrack,
} from 'three';
import type { BoneSpec, MotionBonePose, MotionPose, Quat, Vec3 } from '../../nodes/types';
import { quatFromEulerXYZ } from '../../nodes/bonePose';

/**
 * Sanitize a bone name for THREE-track-binding safety. THREE reserves
 * `[].:/` as track-path syntax (PropertyBinding._RESERVED_CHARS_RE);
 * any of those in a bone name breaks `node.property` lookups during
 * AnimationMixer binding (and thus SkeletonUtils.retargetClip).
 *
 * Mixamo's `mixamorig:Hips` is the canonical case — replace `:` with
 * `_` so the namespace is visible (`mixamorig_Hips`) but the rest of
 * the rig pipeline can read it as a plain identifier.
 *
 * Round-trip cost: importing then re-exporting a Mixamo FBX would lose
 * the original namespace separator. Acceptable for v0.5; export is P7.
 *
 * 🔴 THIS IS NOT THREE'S OWN RULE, AND THE TWO DO NOT COMPOSE (#922).
 * `PropertyBinding.sanitizeNodeName` (PropertyBinding.js:144) REMOVES the same
 * characters and turns whitespace into `_`; this REPLACES them and leaves
 * whitespace alone. Both are defensible and neither is wrong, but they are
 * different strings, and GLTFLoader runs three's version on every node name as
 * it loads (GLTFLoader.js:3655) — so the live scene and our params spell the
 * same bone differently for the whole life of the asset.
 *
 * There is no repair function. `:` → `_` and `:` → `` are two lossy maps and
 * neither composes into the other, and this one is not injective either: a rig
 * that genuinely ships `mixamorig_Hips` is indistinguishable after import from
 * one that shipped `mixamorig:Hips`. Sharing one sanitiser is a stored-name
 * format migration, not a code change.
 *
 * So do not compare a name from here against one from the live scene. Compare
 * by JOINT INDEX, which both sides agree on by construction
 * (`projectGltfSkeleton.ts` INDEX DISCIPLINE), or put both through
 * `canonicalBoneKey` (`retarget.ts`). `boneNameSpaces.test.ts` pins all of it.
 */
export function sanitizeBoneName(name: string): string {
  return name.replace(/[[\].:/]/g, '_');
}

export function bonesToSpec(bones: readonly Object3D[]): BoneSpec[] {
  // THREE nodes carry parent references. A bone's parent is its parent NODE when that node is
  // in the list, found by identity — so a parent that is not a three `Bone` (an FBX `Null`
  // inside a chain, #1184) still links, and two bones that share a name cannot swap parents.
  // A node whose parent is outside the list is a root (-1). Sanitize only the value we
  // project into the POJO BoneSpec.
  const indexOf = new Map<Object3D, number>();
  bones.forEach((b, i) => indexOf.set(b, i));

  return bones.map((bone): BoneSpec => {
    const parent = bone.parent;
    const parentIdx = parent ? (indexOf.get(parent) ?? -1) : -1;
    return {
      name: sanitizeBoneName(bone.name),
      parent: parentIdx,
      position: [bone.position.x, bone.position.y, bone.position.z] as const,
      rotation: quaternionToEulerVec3(bone.quaternion),
      // P7.11 (D-03) — carry bind-pose scale so a BoneSpec → Bone → BoneSpec
      // round-trip is lossless for non-uniform-scale rigs. IBM is deliberately
      // NOT round-tripped here: the adapter has no IBM source (retarget
      // reconstructs inverses from the bind pose); the captured IBM rides only
      // on GltfSkeleton output, never through the retarget clip path.
      scale: [bone.scale.x, bone.scale.y, bone.scale.z] as const,
    };
  });
}

export interface ClipShape {
  readonly tracks: ReadonlyArray<{
    name: string;
    times: ArrayLike<number>;
    values: ArrayLike<number>;
  }>;
}

/**
 * Three's tracks as timed poses by bone name (#1432): one pose per key time, holding every bone keyed
 * at that time. A quaternion track is read as the quaternion it is. A bone keyed at a time on one
 * property only takes the other from its rest: a rotation-only bone keeps its rest offset, a
 * position-only one its rest rotation.
 *
 * A track's bone is found by name in `bones`, the spelling `bonesToSpec` gives (two bones of one name
 * resolve to the later one). The pose names it as `names` does at that index: `bones` by default, or
 * the caller's own spelling of the same rig when `bones` is three's.
 */
export function clipToPoses(
  clip: ClipShape,
  bones: readonly BoneSpec[],
  names: readonly { readonly name: string }[] = bones,
): MotionPose[] {
  type PerBoneTrack = { positionAt: Map<number, Vec3>; quaternionAt: Map<number, Quat> };
  const indexByName = new Map<string, number>();
  bones.forEach((b, i) => indexByName.set(b.name, i));
  const perBone = new Map<number, PerBoneTrack>();
  const ensureBone = (idx: number): PerBoneTrack => {
    let entry = perBone.get(idx);
    if (!entry) perBone.set(idx, (entry = { positionAt: new Map(), quaternionAt: new Map() }));
    return entry;
  };

  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name);
    if (!parsed) continue;
    const boneIdx = indexByName.get(parsed.bone);
    if (boneIdx === undefined) continue;
    const v = track.values;
    if (parsed.property === 'position') {
      const at = ensureBone(boneIdx).positionAt;
      for (let i = 0; i < track.times.length; i++) {
        at.set(track.times[i], [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]);
      }
    } else if (parsed.property === 'quaternion') {
      const at = ensureBone(boneIdx).quaternionAt;
      for (let i = 0; i < track.times.length; i++) {
        const [x, y, z, w] = [v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]];
        // three holds track values as float32, so a quaternion arrives a hair off unit; made unit
        // here, as a pose's quaternion is. A zero one names no rotation and reads as none.
        const n = Math.hypot(x, y, z, w);
        at.set(track.times[i], n > 0 ? [x / n, y / n, z / n, w / n] : [0, 0, 0, 1]);
      }
    }
  }

  const byTime = new Map<number, Record<string, MotionBonePose>>();
  for (const boneIdx of [...perBone.keys()].sort((x, y) => x - y)) {
    const { positionAt, quaternionAt } = perBone.get(boneIdx)!;
    const bind = bones[boneIdx];
    const name = names[boneIdx]?.name ?? bind.name;
    for (const t of new Set([...positionAt.keys(), ...quaternionAt.keys()])) {
      let held = byTime.get(t);
      if (!held) byTime.set(t, (held = {}));
      held[name] = {
        position: positionAt.get(t) ?? bind.position,
        quaternion: quaternionAt.get(t) ?? quatFromEulerXYZ(bind.rotation),
      };
    }
  }
  return [...byTime].sort(([x], [y]) => x - y).map(([time, held]) => ({ time, bones: held }));
}

/** A three track name as the bone (sanitised) and property it keys, or null. */
export function parseTrackName(name: string): { bone: string; property: string } | null {
  const bracket = name.match(/\.bones\[([^\]]+)\]\.(\w+)/);
  if (bracket) return { bone: sanitizeBoneName(bracket[1]), property: bracket[2] };
  const dot = name.match(/^\.?([^.]+)\.(\w+)$/);
  if (dot) return { bone: sanitizeBoneName(dot[1]), property: dot[2] };
  return null;
}

export function quaternionToEulerVec3(q: Quaternion): Vec3 {
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z] as const;
}

// ---------------------------------------------------------------------------
// Inverse adapters — POJO → THREE. Used by retargeting (Wave C) which
// needs THREE.Skeleton + THREE.AnimationClip to call SkeletonUtils
// upstream APIs.
// ---------------------------------------------------------------------------

/**
 * #1183 — a bone whose parent chain never reaches a root, or null when every chain does.
 *
 * A skeleton is a tree: every bone's parents lead to a root (-1). `parent` is only a number,
 * so a list can say otherwise — a bone its own parent, or two bones each other's — and every
 * walk up such a chain runs forever. `retargetClip` froze the tab that way (a synchronous
 * loop in `shallowestMapped`), on skeletons every Mixamo FBX produced before #1181.
 *
 * Named, so a refusal can say which bone. The walk is bounded by the bone count: a chain
 * longer than that has revisited a bone. A parent index outside the list is left to the
 * readers that already treat it as a root.
 */
export function boneOnACycle(
  bones: readonly { readonly name: string; readonly parent: number }[],
): string | null {
  for (let i = 0; i < bones.length; i++) {
    let cur = i;
    for (let step = 0; step <= bones.length; step++) {
      const parent = bones[cur]?.parent ?? -1;
      if (parent < 0 || parent >= bones.length) break;
      cur = parent;
      if (step === bones.length) return bones[cur].name;
    }
  }
  return null;
}

/**
 * Build a THREE.Skeleton from a BoneSpec[]. Each Bone gets its bind-pose
 * position + rotation; parent references are wired by parent index.
 *
 * Returns the skeleton + the constructed bones (callers like retargetClip
 * also want a root Object3D handle for traversal).
 */
export function specToThreeSkeleton(specs: readonly BoneSpec[]): {
  skeleton: Skeleton;
  bones: Bone[];
} {
  const bones: Bone[] = specs.map((s) => {
    const b = new Bone();
    b.name = s.name;
    b.position.set(s.position[0], s.position[1], s.position[2]);
    b.quaternion.setFromEuler(new Euler(s.rotation[0], s.rotation[1], s.rotation[2], 'XYZ'));
    // P7.11 (D-03) — honor non-uniform bind-pose scale so the retarget bind
    // pose (and the inverses `new Skeleton(bones)` reconstructs from it) stays
    // deform-faithful. Guarded on the optional field: legacy BVH/FBX specs
    // leave the Bone's default [1,1,1] untouched.
    if (s.scale) b.scale.set(s.scale[0], s.scale[1], s.scale[2]);
    return b;
  });
  for (let i = 0; i < specs.length; i++) {
    const parentIdx = specs[i].parent;
    if (parentIdx >= 0 && parentIdx < bones.length) {
      bones[parentIdx].add(bones[i]);
    }
  }
  // 🔴 WORLD MATRICES BEFORE `new Skeleton`. THE BIND POSE IS READ FROM THEM.
  //
  // `Skeleton`'s constructor calls `calculateInverses()`, which reads each bone's
  // `matrixWorld`. A freshly constructed Object3D has an IDENTITY `matrixWorld`
  // until something updates it — setting `position`/`quaternion` does not — so a
  // Skeleton built here came out with every `boneInverse` equal to the identity.
  //
  // That is not a dormant inaccuracy. `SkeletonUtils.retarget` calls
  // `skeleton.pose()` on EVERY FRAME, and `pose()` drives each bone from its
  // inverse — so identity inverses actively FLATTEN the whole skeleton to the
  // origin with identity rotations, once per frame.
  //
  // Measured, three bones with a Z-up corrective root:
  //   boneInverses[0..2] identity? true, true, true
  //   after pose(): Root rot [0,0,0] (bind [-90,0,90]), Hips pos [0,0,0]
  //                 (bind [0,0,0.51])
  //
  // One defect, three symptoms: the character folding into a blob at the origin
  // (#828), a rig's corrective root rotation replaced by identity so the whole
  // character lies down (#838), and a walk that never travels (#839).
  //
  // Every bone with no parent is updated, not just `bones[0]`: a spec may
  // describe a forest, and updating one root would leave the others' inverses
  // identity — the same defect, surviving in the bones nobody looked at.
  for (const b of bones) {
    if (!b.parent) b.updateMatrixWorld(true);
  }
  return { skeleton: new Skeleton(bones), bones };
}

/**
 * Build a THREE.AnimationClip from timed poses (#1432): one VectorKeyframeTrack (.position) and one
 * QuaternionKeyframeTrack (.quaternion) per bone of `bones` the poses hold, keyed at the times that
 * hold it. A held bone without a position or a quaternion takes its rest's. Scale is not carried:
 * the retarget, the one caller, keeps the target's own proportions.
 */
export function posesToThreeClip(
  name: string,
  duration: number,
  poses: readonly MotionPose[],
  bones: readonly BoneSpec[],
): AnimationClip {
  const ordered = [...poses].sort((a, b) => a.time - b.time);
  const tracks = [];
  const seen = new Set<string>();
  for (const bone of bones) {
    if (seen.has(bone.name)) continue;
    seen.add(bone.name);
    const times: number[] = [];
    const positions: number[] = [];
    const quats: number[] = [];
    for (const pose of ordered) {
      const held = pose.bones[bone.name];
      if (!held) continue;
      const p = held.position ?? bone.position;
      const q = held.quaternion ?? quatFromEulerXYZ(bone.rotation);
      times.push(pose.time);
      positions.push(p[0], p[1], p[2]);
      quats.push(q[0], q[1], q[2], q[3]);
    }
    if (times.length === 0) continue;
    tracks.push(new VectorKeyframeTrack(`${bone.name}.position`, times, positions));
    tracks.push(new QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, quats));
  }
  return new AnimationClip(name, duration > 0 ? duration : -1, tracks);
}
