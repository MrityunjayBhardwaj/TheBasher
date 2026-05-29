// Skeleton — a hierarchy of named bones in bind pose.
//
// Pure: same params → same skeleton. The skeleton is data; characters and
// animation clips reference it by socket connection. V9 (materials/data,
// not code) extends here: the skeleton is a POJO bone list, not a runtime
// THREE.Skeleton instance.
//
// REF: THESIS.md §40, vyapti V2, V9.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { SkeletonValue } from './types';

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
      }),
    )
    // Default: a 3-bone "stick figure" — root → torso → head.
    // Sufficient for P2's locomotion + pose interpolation.
    .default([
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'torso', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'head', parent: 1, position: [0, 0.6, 0], rotation: [0, 0, 0] },
    ]),
});
export type SkeletonParams = z.infer<typeof SkeletonParams>;

export const SkeletonNode: NodeDefinition<SkeletonParams, SkeletonValue> = {
  type: 'Skeleton',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: SkeletonParams,
  inputs: {},
  outputs: { out: { type: 'Skeleton', cardinality: 'single' } },
  evaluate(params) {
    return {
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
      })),
    };
  },
};
