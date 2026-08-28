// BVH import — converts three's BVHLoader output to our DAG-native
// AnimationClipParams + Skeleton bone list.
//
// Design choice: this module is one of two places (alongside fbx.ts)
// where THREE.AnimationClip / THREE.Skeleton instances exist in our
// codebase. Both immediately project into POJO params shapes via
// threeAdapter.ts. The DAG never holds THREE objects (V2 — pure-flag
// determinism would break since THREE objects carry mutable state).
//
// REF: THESIS §42.1 (P3.1 — Animation import); project_p31_plan.md;
//      vyapti V2 (purity), V3 (time-as-socket).

import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import type { AnimationKeyframe, BoneSpec, Vec3 } from '../../nodes/types';
import { bonesToSpec, clipToKeyframes } from './threeAdapter';
import { readPosedJoints } from './bvhProfile';

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
 * Metres per BVH length unit for a clip already authored in metres. The default
 * everywhere, because it is what this importer has always silently assumed.
 */
export const BVH_UNIT_SCALE_METRES = 1;

/**
 * Metres per BVH length unit for a clip authored in centimetres. Both real
 * producers this repo has measured emit centimetres — a Kimodo clip puts the hip
 * 100 units off the floor, and Mixamo BVH does the same — so this is the ordinary
 * case rather than the exotic one.
 */
export const BVH_UNIT_SCALE_CENTIMETRES = 0.01;

/**
 * Parse a BVH text payload. Throws when three's BVHLoader rejects the
 * input — the caller surfaces the error (drop chain shows a toast,
 * Mutator returns gate-4 rejection).
 *
 * `unitScale` is metres per BVH length unit. BVH carries no unit declaration —
 * the format simply has no field for it — so it cannot be derived from the text
 * and has to arrive from whoever knows what produced the clip. The generation
 * road gets it from the capability, which knows what it emitted (#790); the file
 * road has no such source and still defaults to 1, which is what this importer
 * has always assumed (#791 decides what it should do instead).
 *
 * It scales LENGTHS only — bind offsets and keyed positions. Rotations are
 * angles and are unit-free, and bind scale is a ratio; multiplying either would
 * turn a units mismatch into a deformed rig, which is harder to recognise than a
 * character that is plainly 100x too big.
 */
export function parseBvh(
  text: string,
  name = 'imported-bvh',
  unitScale: number = BVH_UNIT_SCALE_METRES,
): BvhImportResult {
  if (!Number.isFinite(unitScale) || unitScale <= 0) {
    throw new Error(
      `parseBvh: unitScale must be a positive, finite number of metres per BVH unit — got ${unitScale}.`,
    );
  }

  const loader = new BVHLoader();
  const parsed = loader.parse(text);

  const bones = bonesToSpec(parsed.skeleton.bones);
  const keyframes = replaceRestOffsetOnPosedJoints(
    clipToKeyframes(parsed.clip, bones),
    bones,
    text,
  );

  return {
    skeletonParams: { bones: scaleBonePositions(bones, unitScale) },
    clipParams: {
      name,
      duration: parsed.clip.duration > 0 ? parsed.clip.duration : 1,
      loop: true,
      keyframes: scaleKeyframePositions(keyframes, unitScale),
    },
  };
}

/**
 * Undo three's addition of a joint's rest OFFSET to its animated position.
 *
 * `BVHLoader.js:375-377` composes an animated joint's local translation as
 * `frame.position + bone.offset`. For the conventional root, whose OFFSET is
 * `0 0 0`, that is the same as taking the channel — which is why this has never
 * shown up. For a joint declaring BOTH a non-zero OFFSET and position channels it
 * counts the rest pose TWICE, and the character sits one whole rest offset off the
 * floor for the entire clip.
 *
 * The channel IS the translation; the OFFSET is that same translation's REST
 * value. Four independent witnesses, none of them plausibility:
 *
 *   - Blender's reference importer subtracts it —
 *     `Matrix.Translation(Vector(bvh_loc) - bvh_node.rest_head_local)` in
 *     `io_anim_bvh/import_bvh.py`, applied as a pose delta so the final position
 *     is exactly the channel. Identical in Blender 4.5 and 5.1.
 *   - Blender's EXPORTER writes `OFFSET = bone.head_local` made relative to the
 *     parent — the rest head — and the animated position into the channels.
 *   - Kimodo's exporter sets the Hips OFFSET from the skeleton's NEUTRAL pose and
 *     writes the root trajectory into the channels (`kimodo/exports/bvh.py`).
 *   - Kimodo's own shipped T-pose reference has `Hips OFFSET 0 100 0` and a Hips
 *     position channel of `0 100 0`. A delta convention would write zero there.
 *     Under three's rule that reference T-pose imports at twice its own height,
 *     which is as close to a self-refuting artefact as this format offers.
 *
 * ONLY posed joints are corrected, and that is why this reads the header rather
 * than working from the offsets alone. A rotation-only joint has no position
 * channel, so three's `0 + offset` already IS its correct local translation;
 * subtracting there would collapse every limb onto its parent.
 */
function replaceRestOffsetOnPosedJoints(
  keyframes: readonly AnimationKeyframe[],
  bones: readonly BoneSpec[],
  text: string,
): readonly AnimationKeyframe[] {
  const posed = new Set(readPosedJoints(text));
  if (posed.size === 0) return keyframes;
  return keyframes.map((kf) => {
    const bone = bones[kf.bone];
    if (!bone || !posed.has(bone.name)) return kf;
    return {
      ...kf,
      position: [
        kf.position[0] - bone.position[0],
        kf.position[1] - bone.position[1],
        kf.position[2] - bone.position[2],
      ] as Vec3,
    };
  });
}

const scaled = (v: Vec3, by: number): Vec3 => [v[0] * by, v[1] * by, v[2] * by];

function scaleBonePositions(bones: readonly BoneSpec[], by: number): readonly BoneSpec[] {
  if (by === 1) return bones;
  return bones.map((bone) => ({ ...bone, position: scaled(bone.position, by) }));
}

function scaleKeyframePositions(
  keyframes: readonly AnimationKeyframe[],
  by: number,
): readonly AnimationKeyframe[] {
  if (by === 1) return keyframes;
  return keyframes.map((kf) => ({ ...kf, position: scaled(kf.position, by) }));
}
