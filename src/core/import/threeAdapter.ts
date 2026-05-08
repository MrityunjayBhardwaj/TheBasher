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

import { Euler, Quaternion, type Bone } from 'three';
import type { AnimationKeyframe, BoneSpec, Vec3 } from '../../nodes/types';

export function bonesToSpec(bones: readonly Bone[]): BoneSpec[] {
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
  if (bracket) return { bone: bracket[1], property: bracket[2] };
  const dot = name.match(/^\.?([^.]+)\.(\w+)$/);
  if (dot) return { bone: dot[1], property: dot[2] };
  return null;
}

export function quaternionToEulerVec3(q: Quaternion): Vec3 {
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z] as const;
}
