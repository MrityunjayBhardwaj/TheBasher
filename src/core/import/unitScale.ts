// A file's length unit, applied at parse — shared by every importer that has one to apply.
//
// A unit scales LENGTHS only: rest offsets and keyed positions. Rotations are angles and are
// unit-free, and bind scale is a ratio; multiplying either would turn a units mismatch into a
// deformed rig, which is harder to recognise than a character that is plainly 100x too big.
//
// One copy, because the BVH road (a unit a generator declares, #790) and the FBX road (a unit
// the file declares, #1086) apply the same arithmetic, and two copies of it would be free to
// disagree about which fields count as a length.
//
// REF: src/core/import/bvh.ts (`parseBvh`), src/core/import/fbx.ts (`readFbx`).

import type { BoneSpec, MotionPose, Vec3 } from '../../nodes/types';

const scaled = (v: Vec3, by: number): Vec3 => [v[0] * by, v[1] * by, v[2] * by];

/** Rest offsets carried into metres. */
export function scaleBonePositions(bones: readonly BoneSpec[], by: number): readonly BoneSpec[] {
  if (by === 1) return bones;
  return bones.map((bone) => ({ ...bone, position: scaled(bone.position, by) }));
}

/** Posed positions carried into metres. */
export function scalePosePositions(poses: readonly MotionPose[], by: number): MotionPose[] {
  if (by === 1) return [...poses];
  return poses.map((pose) => ({
    time: pose.time,
    bones: Object.fromEntries(
      Object.entries(pose.bones).map(([name, held]) => [
        name,
        held.position ? { ...held, position: scaled(held.position, by) } : held,
      ]),
    ),
  }));
}
