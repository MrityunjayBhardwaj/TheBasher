// bakePose — turn a character's computed motion into keys on a pose layer (#1215).
//
// The agent's door to the one bake (`src/app/animate/bakePose.ts`): the wire at the chain's source (a
// retarget, a generated clip) or at one of its layers becomes an override layer of keys at the bottom
// of the armature Object's pose chain; what it read before is detached and kept. Blender: NLA "Bake
// Action" (`nla.bake`); Houdini: Rig Pose's Bake Range.
//
// Scope: the Object, its pose chain (`pose`: the layers and the source), its skeleton (`data`: the
// baked layer reads its rest pose) and the fresh layer id.
//
// REF: src/app/animate/bakePose.ts; issue #1215.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSpec } from '../../closure/types';
import type { Op } from '../../../core/dag/types';
import { bakePose, bakedLayerIdFor, type BakePoseArgs } from '../../../app/animate/bakePose';

const BakePoseSpec = z.object({
  /** The armature Object whose motion is baked. */
  object: z.string().min(1),
  /** A pose layer under it: bake its output, folding it and the layers below in. Absent: the source. */
  at: z.string().min(1).optional(),
  /** Which poses: every one, every Nth (the last kept), or these seconds. */
  poses: z
    .union([
      z.literal('every'),
      z.object({ nth: z.number().int().min(1) }),
      z.object({ times: z.array(z.number().nonnegative()).min(1) }),
    ])
    .default('every'),
  interpolation: z.enum(['linear', 'constant']).default('linear'),
  /** The baked layer's id; defaults to `<object>_baked_pose`. */
  layerId: z.string().min(1).optional(),
});
export type BakePoseSpec = z.infer<typeof BakePoseSpec>;

function argsOf(spec: BakePoseSpec): BakePoseArgs {
  const p = spec.poses;
  return {
    object: spec.object,
    ...(spec.at !== undefined ? { at: spec.at } : {}),
    poses:
      p === 'every'
        ? { kind: 'every' }
        : 'nth' in p
          ? { kind: 'nth', n: p.nth }
          : { kind: 'times', times: p.times },
    interpolation: spec.interpolation,
    layerId: spec.layerId ?? bakedLayerIdFor(spec.object),
  };
}

export const bakePoseMutator: MutatorDefinition<BakePoseSpec> = {
  name: 'mutator.animate.bakePose',
  description:
    "Bake an armature Object's computed motion (a retarget, a generated clip) into editable keys on " +
    'a pose layer: every pose, every Nth or chosen times. The layer becomes its base; the source is ' +
    'detached, kept. With `at` a layer, it and the layers below fold into the keys and are muted.',
  spec: BakePoseSpec,
  specExample: { object: 'node_id', poses: { nth: 2 }, interpolation: 'linear' },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['Skeleton'],
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.object, spec.layerId ?? bakedLayerIdFor(spec.object)],
      followedEdges: ['pose', 'data'],
    };
  },
  preconditions(spec, _closure, state) {
    const result = bakePose(state, argsOf(spec));
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  },
  build(spec, _closure, state): Op[] {
    const result = bakePose(state, argsOf(spec));
    return result.ok ? [...result.ops] : [];
  },
  advisories(spec, _closure, state) {
    const result = bakePose(state, argsOf(spec));
    if (!result.ok) return [];
    const { times, bones, muted, detached } = result.report;
    return [
      `${times.length} poses × ${bones} bones keyed`,
      ...(detached ? [`${detached.node} no longer drives the character (kept, not deleted)`] : []),
      ...(muted.length > 0 ? [`muted: ${muted.join(', ')}`] : []),
    ];
  },
};
