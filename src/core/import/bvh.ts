// BVH import — converts three's BVHLoader output to our DAG-native
// AnimationClipParams + Skeleton bone list.
//
// Design choice: this module is the only place THREE.AnimationClip /
// THREE.Skeleton instances exist in our codebase. We immediately project
// them into POJO params shapes. The DAG never holds THREE objects (V2 —
// pure-flag determinism would break since THREE objects carry mutable
// state).
//
// Conversions:
//   - THREE.Bone tree → BoneSpec[] with parent indices (DAG uses indices,
//     THREE uses parent references).
//   - QuaternionKeyframeTrack → Euler (XYZ order, matches Blender / Unity /
//     Unreal convention per dcc-reference.md §1). Lossy at gimbal lock,
//     acceptable for v0.5 (Mixamo + most BVH sources author in Euler
//     anyway; THREE's quaternion is an interchange format).
//   - Per-bone tracks merged into our (bone, time, position, rotation)
//     keyframe model. Bones without a position track inherit the
//     bind-pose translation per keyframe.
//
// REF: THESIS §42.1 (P3.1 — Animation import); project_p31_plan.md;
//      vyapti V2 (purity), V3 (time-as-socket).

import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { Euler, Quaternion, type Bone } from 'three';
import type {
  AnimationKeyframe,
  BoneSpec,
  Vec3,
} from '../../nodes/types';

export interface BvhSkeletonParams {
  readonly bones: readonly BoneSpec[];
}

export interface BvhClipParams {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly keyframes: readonly AnimationKeyframe[];
}

export interface BvhImportResult {
  readonly skeletonParams: BvhSkeletonParams;
  readonly clipParams: BvhClipParams;
}

/**
 * Parse a BVH text payload. Throws when three's BVHLoader rejects the
 * input — the caller surfaces the error (drop chain shows a toast,
 * Mutator returns gate-4 rejection).
 */
export function parseBvh(text: string, name = 'imported-bvh'): BvhImportResult {
  const loader = new BVHLoader();
  const parsed = loader.parse(text);
  // BVHLoader returns { skeleton, clip } — skeleton.bones is the THREE.Bone[]
  // array; clip is a THREE.AnimationClip with one quaternion track per bone
  // and a single position track on the root.

  const bones = bonesToSpec(parsed.skeleton.bones);
  const keyframes = clipToKeyframes(parsed.clip, bones);

  return {
    skeletonParams: { bones },
    clipParams: {
      name,
      // BVHLoader leaves clip.duration set; defaults to track-max if missing.
      duration: parsed.clip.duration > 0 ? parsed.clip.duration : 1,
      loop: true,
      keyframes,
    },
  };
}

function bonesToSpec(bones: readonly Bone[]): BoneSpec[] {
  // THREE bones carry parent references. Build a name → index map so we
  // can resolve parent indices in one pass. Root bones have parent = -1.
  const indexByName = new Map<string, number>();
  bones.forEach((b, i) => indexByName.set(b.name, i));

  return bones.map((bone): BoneSpec => {
    const parent = bone.parent;
    const parentIdx =
      parent && (parent as Bone).isBone ? (indexByName.get(parent.name) ?? -1) : -1;
    return {
      name: bone.name,
      parent: parentIdx,
      position: [bone.position.x, bone.position.y, bone.position.z] as const,
      rotation: quaternionToEulerVec3(bone.quaternion),
    };
  });
}

function clipToKeyframes(
  clip: { tracks: ReadonlyArray<{ name: string; times: ArrayLike<number>; values: ArrayLike<number> }> },
  bones: readonly BoneSpec[],
): AnimationKeyframe[] {
  // Build per-bone tracks indexed by bone name. Each entry holds the
  // sampled position+rotation per time step — we merge them together at
  // the end into our flat (bone, time, position, rotation) keyframe shape.
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
    // Track names are like ".bones[hip].position" or "hip.quaternion"
    // depending on loader version. THREE.PropertyBinding parses both.
    // For simplicity, extract the bone name and the property name via a
    // regex — handles both shapes.
    const parsed = parseTrackName(track.name);
    if (!parsed) continue;
    const boneIdx = indexByName.get(parsed.bone);
    if (boneIdx === undefined) continue;

    if (parsed.property === 'position') {
      // Vector3 track — values stride 3.
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
      // Quaternion track — values stride 4 (xyzw). Convert to Euler (XYZ).
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        const q = new Quaternion(
          track.values[i * 4 + 0],
          track.values[i * 4 + 1],
          track.values[i * 4 + 2],
          track.values[i * 4 + 3],
        );
        const eulerVec = quaternionToEulerVec3(q);
        const entry = ensureBone(boneIdx);
        entry.times.add(t);
        entry.rotationAt.set(t, eulerVec);
      }
    }
    // Other properties (scale, morphTargetInfluences) ignored in v0.5.
  }

  // Flatten per-bone tracks into our keyframe array. For each (bone,
  // time), use the position + rotation present in the track maps; fall
  // through to bind-pose values when missing.
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
  // Sort by (time, bone) for deterministic ordering. The AnimationClip
  // evaluator re-groups by bone internally, so the only behavioral
  // difference is keyframe array order — but determinism matters for
  // hash-based caching (V2).
  out.sort((a, b) => a.time - b.time || a.bone - b.bone);
  return out;
}

function parseTrackName(name: string): { bone: string; property: string } | null {
  // ".bones[Name].property" form (older loaders) or "Name.property" form.
  const bracket = name.match(/\.bones\[([^\]]+)\]\.(\w+)/);
  if (bracket) return { bone: bracket[1], property: bracket[2] };
  const dot = name.match(/^\.?([^.]+)\.(\w+)$/);
  if (dot) return { bone: dot[1], property: dot[2] };
  return null;
}

function quaternionToEulerVec3(q: Quaternion): Vec3 {
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z] as const;
}
