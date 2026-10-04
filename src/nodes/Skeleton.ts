// Skeleton — a hierarchy of named bones in bind pose.
//
// Pure: same params → same skeleton. The skeleton is data; characters and
// animation clips reference it by socket connection. V9 (materials/data,
// not code) extends here: the skeleton is a POJO bone list, not a runtime
// THREE.Skeleton instance.
//
// #1211 (step 4 of "Bones as Channels", #1233) — a second output, `pose`: the skeleton standing at
// rest, the same at every time. It is the source at the bottom of a pose chain whose motion lives in
// pose layers (Skeleton.pose → PoseLayer … → Object.pose). Houdini: a rest skeleton on a wire IS a
// pose, and layers and Joint Deform take it as one. Blender: an armature with no action stands at
// rest. Built once per graph change; `sample` returns the same list at every time.
//
// REF: THESIS.md §40, vyapti V2, V9; design ref/architecture/bone-channels-design.html (v7, the
//      structure: "Skeleton ─► rest pose"); issue #1211.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BonePose, PosedSkeletonValue, SkeletonValue } from './types';
import { restBonePose } from './bonePose';
import { boneOnACycle } from '../core/import/threeAdapter';

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const SkeletonParams = z.object({
  bones: z
    .array(
      z.object({
        name: z.string(),
        parent: z.number().int().min(-1),
        position: Vec3.default([0, 0, 0]),
        rotation: Vec3.default([0, 0, 0]),
        // P7.11 (D-03) — OPTIONAL bind-pose extras. Absent on the 3-bone
        // default + every BVH/FBX-emitted Skeleton (back-compat / F4); only a
        // glTF-projected rig populates them. No `.default(...)` so an omitted
        // field stays omitted (keeps value-equality clean for legacy saves).
        scale: Vec3.optional(),
        inverseBindMatrix: z.array(z.number()).length(16).optional(),
        // #1340 — the IK solve's starting bend (`BoneSpec.preferredAngle`). Optional, no default,
        // for the same value-equality reason as `scale`.
        preferredAngle: Vec3.optional(),
      }),
    )
    // #1183 — a skeleton is a tree. A write whose parent chain loops is refused here,
    // naming the bone, instead of freezing whatever walks the chain later.
    .superRefine((bones, ctx) => {
      const bone = boneOnACycle(bones);
      if (bone !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bone "${bone}" is its own ancestor — its parent chain loops instead of reaching a root`,
        });
      }
    })
    // Default: a 3-bone "stick figure" — root → torso → head.
    // Sufficient for P2's locomotion + pose interpolation.
    .default([
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'torso', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'head', parent: 1, position: [0, 0.6, 0], rotation: [0, 0, 0] },
    ]),
});
export type SkeletonParams = z.infer<typeof SkeletonParams>;

/** The skeleton, and the skeleton at rest as a pose. */
export type SkeletonOutputs = { readonly out: SkeletonValue; readonly pose: PosedSkeletonValue };

/** A skeleton standing at rest: one list, built on the first sample and returned at every time. */
export function restPoseOf(skeleton: SkeletonValue): PosedSkeletonValue {
  let rest: readonly BonePose[] | null = null;
  return {
    kind: 'PosedSkeleton',
    skeleton,
    sample: () => (rest ??= skeleton.bones.map(restBonePose)),
    rest: true,
  };
}

export const SkeletonNode: NodeDefinition<SkeletonParams, SkeletonOutputs> = {
  type: 'Skeleton',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: SkeletonParams,
  inputs: {},
  outputs: {
    out: { type: 'Skeleton', cardinality: 'single' },
    pose: { type: 'PosedSkeleton', cardinality: 'single' },
  },
  evaluate(params): SkeletonOutputs {
    const out: SkeletonValue = {
      kind: 'Skeleton',
      bones: params.bones.map((b) => ({
        name: b.name,
        parent: b.parent,
        position: b.position,
        rotation: b.rotation,
        // P7.11 (D-03/D-04) — only spread when present so a legacy bone (no
        // scale/IBM) produces a byte-identical BoneSpec (no `scale: undefined`
        // key). Back-compat: BVH/FBX + the 3-bone default are unchanged.
        ...(b.scale !== undefined ? { scale: b.scale } : {}),
        ...(b.inverseBindMatrix !== undefined ? { inverseBindMatrix: b.inverseBindMatrix } : {}),
        ...(b.preferredAngle !== undefined ? { preferredAngle: b.preferredAngle } : {}),
      })),
    };
    return { out, pose: restPoseOf(out) };
  },
};
