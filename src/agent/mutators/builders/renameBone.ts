// renameBone — rename one bone of an armature, and every record that names it (#1201).
//
// The agent's door to the same rename the N-panel's bone name field makes: both call `renameBone`
// (`src/app/animate/renameBone.ts`), which finds every copy of the name through the graph — the
// skeleton, the pose layers under each armature Object standing it, Objects parented to the bone, the
// vertex group of each mesh an Armature modifier deforms by it, and bone maps — and rewrites each whole.
//
// Blender: `ED_armature_bone_rename` walks every Object in the file for the same reason. The scope
// declared here is the `rig` kind: the same walk (`rigReach`) the rename rewrites through, since the
// records sit on both sides of the armature Object and no single-direction kind reaches them all.
//
// REF: src/app/animate/renameBone.ts; issue #1201.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSpec } from '../../closure/types';
import type { Op } from '../../../core/dag/types';
import { renameBone } from '../../../app/animate/renameBone';

const RenameBoneSpec = z.object({
  /** The armature Object whose skeleton holds the bone. */
  object: z.string().min(1),
  /** The bone's current name, in the skeleton's spelling. */
  bone: z.string().min(1),
  /** The name to give it; made unique among the skeleton's bones as Blender does (`.001`). */
  name: z.string(),
});
export type RenameBoneSpec = z.infer<typeof RenameBoneSpec>;

export const renameBoneMutator: MutatorDefinition<RenameBoneSpec> = {
  name: 'mutator.animate.renameBone',
  description:
    'Rename a bone of an armature Object. Its keys in every pose layer, Objects parented to it, the ' +
    'vertex group of each mesh it deforms and bone maps follow, as in Blender. A name another bone ' +
    "has gets '.001'; a mesh that already has a group of the new name keeps its groups (reported).",
  spec: RenameBoneSpec,
  specExample: { object: 'node_id', bone: 'Bone1', name: 'Forearm.L' },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['Skeleton'],
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.object], followedEdges: ['rig'] };
  },
  preconditions(spec, _closure, state) {
    const result = renameBone(state, spec.object, spec.bone, spec.name);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  },
  build(spec, _closure, state): Op[] {
    const result = renameBone(state, spec.object, spec.bone, spec.name);
    return result.ok ? [...result.ops] : [];
  },
  advisories(spec, _closure, state) {
    const result = renameBone(state, spec.object, spec.bone, spec.name);
    if (!result.ok) return [];
    const { name, left } = result.report;
    return [
      ...(name !== spec.name ? [`the bone is named “${name}”: “${spec.name}” was taken`] : []),
      ...left.map((l) => `${l.node}: ${l.why}`),
    ];
  },
};
