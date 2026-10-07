// editSkeleton — build and change an armature's rest skeleton (#1339).
//
// The agent's door to the same operations Edit mode's keys and panel make: both call
// `applySkeletonEdit` (`src/app/animate/editSkeleton.ts`), so a skeleton the agent builds is the one a
// director would have built with the same steps. One verb with an `edit` field rather than one verb
// per operation: they share an anchor, a scope and a write, and the catalog stays one entry.
//
// The write is the Skeleton node's `bones`, rewritten whole. New joints go to the end of the list
// and an operation never renames an existing joint, so a pose layer member, a key channel or a
// vertex group that names a bone keeps naming the same one. Deleting a bone leaves whatever named it
// pointing at a bone that is gone; that is said, by node, rather than cleaned up silently.
//
// REF: src/app/animate/editSkeleton.ts; src/agent/mutators/builders/renameBone.ts (the sibling);
//      issue #1339.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { applySkeletonEdit, type SkeletonEdit } from '../../../app/animate/editSkeleton';
import { rigReach } from '../../../app/animate/renameBone';
import { ikControlsOf, mirroredIkOps } from '../../../app/animate/addIk';
import type { PoseLayerParams } from '../../../nodes/PoseLayer';
import type { BoneSpec } from '../../../nodes/types';
import { AxisRange } from '../../../nodes/Skeleton';

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const BoneName = z.string().min(1);

const Edit = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    parent: BoneName.nullable(),
    position: Vec3,
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal('extrude'),
    from: BoneName,
    offset: Vec3.optional(),
    name: z.string().optional(),
  }),
  z.object({ op: z.literal('subdivide'), bone: BoneName, cuts: z.number().int().min(1).max(64) }),
  z.object({ op: z.literal('delete'), bone: BoneName, reparent: z.boolean().default(true) }),
  z.object({ op: z.literal('parent'), bone: BoneName, parent: BoneName.nullable() }),
  z.object({ op: z.literal('reroot'), bone: BoneName }),
  z.object({
    op: z.literal('transform'),
    bone: BoneName,
    position: Vec3.optional(),
    rotation: Vec3.optional(),
    scale: Vec3.optional(),
    children: z.enum(['follow', 'stay']).default('follow'),
  }),
  // #1340 — orient a joint (or a chain) to its child, rolling +Z toward a direction.
  z.object({
    op: z.literal('orient'),
    bone: BoneName,
    up: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('axis'), axis: Vec3 }),
      z.object({ kind: z.literal('tangent'), axis: z.enum(['+X', '-X', '+Z', '-Z']) }),
      z.object({ kind: z.literal('matchBone'), bone: BoneName }),
      z.object({ kind: z.literal('point'), point: Vec3 }),
    ]),
    chain: z.boolean().optional(),
    axisOnly: z.boolean().optional(),
  }),
  z.object({ op: z.literal('preferredAngle'), bone: BoneName, angle: Vec3.nullable() }),
  // #1344 — joint limits: per axis [min, max] radians from rest; an axis left out is free.
  z.object({
    op: z.literal('limits'),
    bone: BoneName,
    limits: z
      .object({ x: AxisRange.optional(), y: AxisRange.optional(), z: AxisRange.optional() })
      .nullable(),
  }),
  // #1341 — mirror bones with a side in their name onto their twins.
  z.object({
    op: z.literal('symmetrize'),
    bones: z.array(BoneName).min(1),
    axis: z.enum(['X', 'Y', 'Z']).optional(),
    direction: z.enum(['negative', 'positive']).optional(),
  }),
]);

const EditSkeletonSpec = z.object({
  /** The armature Object whose skeleton is edited. */
  object: z.string().min(1),
  edit: Edit,
});
export type EditSkeletonSpec = z.infer<typeof EditSkeletonSpec>;

/** The Skeleton node and its bones, or why there is none. */
function skeletonOf(
  state: DagState,
  objectId: string,
): { id: string; bones: BoneSpec[] } | { reason: string } {
  const reach = rigReach(state, objectId);
  if (!reach) {
    return {
      reason: `"${objectId}" is not an armature Object (an Object whose data is a Skeleton).`,
    };
  }
  const bones = (state.nodes[reach.skeleton].params as { bones?: BoneSpec[] }).bones ?? [];
  return { id: reach.skeleton, bones };
}

/**
 * #1341 — the edit as run: a symmetrize also mirrors the goal and pole of each ik layer whose tip it
 * mirrors (they are roots, never under the bones a director lists).
 */
function editAsRun(spec: EditSkeletonSpec, state: DagState): SkeletonEdit {
  const edit = spec.edit as SkeletonEdit;
  if (edit.op !== 'symmetrize') return edit;
  return { ...edit, bones: [...edit.bones, ...ikControlsOf(state, spec.object, edit.bones)] };
}

function run(spec: EditSkeletonSpec, state: DagState) {
  const skel = skeletonOf(state, spec.object);
  if ('reason' in skel) return { ok: false as const, reason: skel.reason };
  const result = applySkeletonEdit(skel.bones, editAsRun(spec, state));
  return result.ok ? { ...result, skeletonId: skel.id } : result;
}

/** #1341 — a symmetrize's twin ik layers, made or updated; none for any other edit. */
function ikMirrorOf(spec: EditSkeletonSpec, state: DagState, bonesAfter: readonly BoneSpec[]) {
  return spec.edit.op === 'symmetrize'
    ? mirroredIkOps(state, spec.object, spec.edit.bones, bonesAfter)
    : { ops: [], mirrored: [] };
}

export const editSkeletonMutator: MutatorDefinition<EditSkeletonSpec> = {
  name: 'mutator.rig.editSkeleton',
  description:
    "Build or change an armature's rest skeleton, as Edit mode does. `edit.op`: add, extrude " +
    '(a child of a joint), subdivide (split the link to its one child), delete (children go to ' +
    'its parent unless reparent is false), parent (null = root), reroot, transform (rest ' +
    'position/rotation/scale; children follow or stay), orient (aim +Y at the child, roll +Z ' +
    'toward `up`), preferredAngle (the IK start bend), limits (per axis [min, max] radians from ' +
    'rest, which posing and IK stop at; null clears), or symmetrize (mirror L/R-named bones onto ' +
    'their twins, made or updated, with the IK of any hand among them). Joints not moved keep their place.',
  spec: EditSkeletonSpec,
  specExample: { object: 'node_id', edit: { op: 'extrude', from: 'Bone' } },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['Skeleton'],
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'animation'],
    // `delete` removes a bone, and what named it is left naming nothing (said in the advisories).
    lossy: [{ kind: 'delete', reason: 'The delete op removes a bone from the skeleton.' }],
  },
  buildClosureSpec(spec): ClosureSpec {
    // #1341 — `pose`: a symmetrize updates the twin ik layers in the Object's chain.
    return { rootSelectors: [spec.object], followedEdges: ['rig', 'pose'] };
  },
  preconditions(spec, _closure, state) {
    const result = run(spec, state);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  },
  build(spec, _closure, state): Op[] {
    const result = run(spec, state);
    if (!result.ok) return [];
    return [
      { type: 'setParam', nodeId: result.skeletonId, paramPath: 'bones', value: result.bones },
      ...ikMirrorOf(spec, state, result.bones).ops,
    ];
  },
  advisories(spec, _closure, state) {
    const result = run(spec, state);
    if (!result.ok) return [];
    const notes = result.added.length > 0 ? [`added ${result.added.join(', ')}`] : [];
    const { mirrored } = ikMirrorOf(spec, state, result.bones);
    if (mirrored.length > 0) notes.push(`mirrored the IK of ${mirrored.join(', ')}`);
    if (spec.edit.op !== 'delete') return notes;
    const gone = spec.edit.bone;
    const reach = rigReach(state, spec.object)!;
    for (const layer of reach.layers) {
      const params = state.nodes[layer].params as PoseLayerParams;
      if (
        params.members.some((m) => m.bone === gone) ||
        params.channels.some((c) => c.bone === gone)
      ) {
        notes.push(`${layer}: still poses or keys "${gone}", which no longer exists`);
      }
    }
    return notes;
  },
};
