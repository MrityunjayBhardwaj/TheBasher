// Shared THREE → DAG-native projection. BVH and FBX import paths both
// produce THREE.Skeleton + THREE.AnimationClip pairs that need to be
// flattened into our POJO Skeleton/AnimationClip params.
//
// Extracted from bvh.ts when fbx.ts landed — second use crossed the
// dharana §4 threshold ("Wait for a second use"). Sole responsibility:
// translate THREE-side shapes into BoneSpec[] + AnimationKeyframe[].
//
// Conversions:
//   - Bone tree → BoneSpec[] with parent indices (DAG uses indices,
//     THREE uses parent references).
//   - QuaternionKeyframeTrack → Euler (XYZ order, matches Blender / Unity /
//     Unreal / Godot per dcc-reference §1). Lossy at gimbal lock.
//   - Per-bone tracks merged into flat (bone, time, position, rotation)
//     keyframe entries; bones without a position track inherit bind-pose.

import {
  AnimationClip,
  Bone,
  Euler,
  QuaternionKeyframeTrack,
  Quaternion,
  Skeleton,
  VectorKeyframeTrack,
} from 'three';
import type { AnimationKeyframe, BoneSpec, Vec3 } from '../../nodes/types';

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
 */
export function sanitizeBoneName(name: string): string {
  return name.replace(/[[\].:/]/g, '_');
}

export function bonesToSpec(bones: readonly Bone[]): BoneSpec[] {
  // THREE bones carry parent references. Build a name → index map so we
  // can resolve parent indices in one pass. Root bones have parent = -1.
  // Index by ORIGINAL name (THREE-side) so parent links stay correct;
  // sanitize only the value we project into the POJO BoneSpec.
  const indexByName = new Map<string, number>();
  bones.forEach((b, i) => indexByName.set(b.name, i));

  return bones.map((bone): BoneSpec => {
    const parent = bone.parent;
    const parentIdx =
      parent && (parent as Bone).isBone ? (indexByName.get(parent.name) ?? -1) : -1;
    return {
      name: sanitizeBoneName(bone.name),
      parent: parentIdx,
      position: [bone.position.x, bone.position.y, bone.position.z] as const,
      rotation: quaternionToEulerVec3(bone.quaternion),
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

export function clipToKeyframes(
  clip: ClipShape,
  bones: readonly BoneSpec[],
): AnimationKeyframe[] {
  type PerBoneTrack = {
    times: Set<number>;
    positionAt: Map<number, Vec3>;
    rotationAt: Map<number, Vec3>;
  };
  const indexByName = new Map<string, number>();
  bones.forEach((b, i) => indexByName.set(b.name, i));
  const perBone = new Map<number, PerBoneTrack>();
  const ensureBone = (idx: number): PerBoneTrack => {
    let entry = perBone.get(idx);
    if (!entry) {
      entry = { times: new Set(), positionAt: new Map(), rotationAt: new Map() };
      perBone.set(idx, entry);
    }
    return entry;
  };

  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name);
    if (!parsed) continue;
    const boneIdx = indexByName.get(parsed.bone);
    if (boneIdx === undefined) continue;

    if (parsed.property === 'position') {
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        const v: Vec3 = [
          track.values[i * 3 + 0],
          track.values[i * 3 + 1],
          track.values[i * 3 + 2],
        ];
        const entry = ensureBone(boneIdx);
        entry.times.add(t);
        entry.positionAt.set(t, v);
      }
    } else if (parsed.property === 'quaternion') {
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        const q = new Quaternion(
          track.values[i * 4 + 0],
          track.values[i * 4 + 1],
          track.values[i * 4 + 2],
          track.values[i * 4 + 3],
        );
        const entry = ensureBone(boneIdx);
        entry.times.add(t);
        entry.rotationAt.set(t, quaternionToEulerVec3(q));
      }
    }
  }

  const out: AnimationKeyframe[] = [];
  for (const [boneIdx, track] of perBone.entries()) {
    const bind = bones[boneIdx];
    const times = Array.from(track.times).sort((a, b) => a - b);
    for (const t of times) {
      out.push({
        bone: boneIdx,
        time: t,
        position: track.positionAt.get(t) ?? bind.position,
        rotation: track.rotationAt.get(t) ?? bind.rotation,
      });
    }
  }
  out.sort((a, b) => a.time - b.time || a.bone - b.bone);
  return out;
}

function parseTrackName(name: string): { bone: string; property: string } | null {
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
    return b;
  });
  for (let i = 0; i < specs.length; i++) {
    const parentIdx = specs[i].parent;
    if (parentIdx >= 0 && parentIdx < bones.length) {
      bones[parentIdx].add(bones[i]);
    }
  }
  return { skeleton: new Skeleton(bones), bones };
}

/**
 * Build a THREE.AnimationClip from our flat keyframe model. Groups
 * keyframes by bone, emits one VectorKeyframeTrack (.position) and one
 * QuaternionKeyframeTrack (.quaternion) per bone that has keyframes.
 */
export function paramsToThreeClip(
  name: string,
  duration: number,
  keyframes: readonly AnimationKeyframe[],
  bones: readonly BoneSpec[],
): AnimationClip {
  type PerBone = { times: number[]; positions: number[]; quats: number[] };
  const grouped = new Map<number, PerBone>();
  // Stable order: by bone, then time.
  const sortedKfs = [...keyframes].sort((a, b) => a.bone - b.bone || a.time - b.time);
  for (const kf of sortedKfs) {
    let entry = grouped.get(kf.bone);
    if (!entry) {
      entry = { times: [], positions: [], quats: [] };
      grouped.set(kf.bone, entry);
    }
    entry.times.push(kf.time);
    entry.positions.push(kf.position[0], kf.position[1], kf.position[2]);
    const q = new Quaternion().setFromEuler(
      new Euler(kf.rotation[0], kf.rotation[1], kf.rotation[2], 'XYZ'),
    );
    entry.quats.push(q.x, q.y, q.z, q.w);
  }

  const tracks = [];
  for (const [boneIdx, entry] of grouped.entries()) {
    const boneName = bones[boneIdx]?.name ?? `bone_${boneIdx}`;
    tracks.push(
      new VectorKeyframeTrack(`${boneName}.position`, entry.times, entry.positions),
    );
    tracks.push(
      new QuaternionKeyframeTrack(`${boneName}.quaternion`, entry.times, entry.quats),
    );
  }
  return new AnimationClip(name, duration > 0 ? duration : -1, tracks);
}
