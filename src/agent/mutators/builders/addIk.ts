// addIk — Add › IK on a bone (#1510): the agent's door to the gesture Pose mode's Shift+I makes.
//
// Both roads call `planAddIk` (`src/app/animate/addIk.ts`), so the chain, the control bones, the pole
// angle and where the layer goes are decided once. The write is ONE step: the skeleton's bones with
// the goal and pole added at the end (no existing joint moves or is renamed), and an `ik` pose layer
// spliced in directly under the Object, above every FK layer it solves over.
//
// REF: src/app/animate/addIk.ts (the plan); src/agent/mutators/builders/editSkeleton.ts (the sibling
//      that writes the same `bones`); issue #1510.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSpec } from '../../closure/types';
import type { Op } from '../../../core/dag/types';
import { addIkOps, ikLayerIdFor, planAddIk } from '../../../app/animate/addIk';

const AddIkSpec = z.object({
  /** The armature Object. */
  object: z.string().min(1),
  /** The tip joint (a hand, a foot): its parent and grandparent are the chain that bends. */
  bone: z.string().min(1),
  /** An existing bone to reach for; absent, a new goal bone is made where the tip is drawn. */
  goal: z.string().min(1).optional(),
  /** Seconds: the drawn pose the control bones are placed against (the playhead). */
  time: z.number().nonnegative().optional(),
});
export type AddIkSpec = z.infer<typeof AddIkSpec>;

const plan = (spec: AddIkSpec, state: Parameters<typeof planAddIk>[0]) =>
  planAddIk(state, {
    object: spec.object,
    bone: spec.bone,
    ...(spec.goal !== undefined ? { goal: spec.goal } : {}),
    seconds: spec.time ?? 0,
  });

export const addIkMutator: MutatorDefinition<AddIkSpec> = {
  name: 'mutator.rig.addIk',
  // The first sentence is the picker payload: it ends before a capital.
  description:
    'Add a two-bone IK to an armature tip joint (Shift+I). ' +
    '`bone` is the tip (a hand), its parent and grandparent bend; a new goal bone is made where the ' +
    'tip is drawn at `time` unless `goal` names one, and a pole bone in front of the elbow. The ' +
    'ik layer goes on top of the pose chain, so the pose on screen does not change until the goal moves.',
  spec: AddIkSpec,
  specExample: { object: 'node_id', bone: 'Hand' },
  contract: {
    requiredEdges: [],
    // The anchor is an armature Object, and its rig is what changes.
    requiredNodeTypes: ['Object', 'Skeleton'],
    // Not `animation`: away from the playhead the chain now follows the goal, not its FK keys.
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.object, ikLayerIdFor(spec.object, spec.bone)],
      followedEdges: ['rig', 'pose'],
    };
  },
  preconditions(spec, _closure, state) {
    const result = plan(spec, state);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  },
  build(spec, _closure, state): Op[] {
    const result = plan(spec, state);
    return result.ok ? addIkOps(spec.object, result) : [];
  },
  advisories(spec, _closure, state) {
    const result = plan(spec, state);
    if (!result.ok) return [];
    const { ik } = result.layer;
    return [
      `added ${result.added.join(', ')}`,
      `${ik.root} → ${ik.mid} → ${ik.tip} reaches "${ik.goal}", bending toward "${ik.pole}"`,
    ];
  },
};
