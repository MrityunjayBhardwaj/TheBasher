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
import type { PoseLayerParams } from '../../../nodes/PoseLayer';
import type { BoneSpec } from '../../../nodes/types';

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

function run(spec: EditSkeletonSpec, state: DagState) {
  const skel = skeletonOf(state, spec.object);
  if ('reason' in skel) return { ok: false as const, reason: skel.reason };
  const result = applySkeletonEdit(skel.bones, spec.edit as SkeletonEdit);
  return result.ok ? { ...result, skeletonId: skel.id } : result;
}

export const editSkeletonMutator: MutatorDefinition<EditSkeletonSpec> = {
  name: 'mutator.rig.editSkeleton',
  description:
    "Build or change an armature's rest skeleton, as Edit mode does. `edit.op`: add, extrude " +
    '(a child of a joint), subdivide (split the link to its one child), delete (children go to ' +
    'its parent unless reparent is false), parent (null = root), reroot, or transform (rest ' +
    'position/rotation/scale; children follow or stay). Joints that are not moved keep their place.',
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
    return { rootSelectors: [spec.object], followedEdges: ['rig'] };
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
    ];
  },
  advisories(spec, _closure, state) {
    const result = run(spec, state);
    if (!result.ok) return [];
    const notes = result.added.length > 0 ? [`added ${result.added.join(', ')}`] : [];
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
