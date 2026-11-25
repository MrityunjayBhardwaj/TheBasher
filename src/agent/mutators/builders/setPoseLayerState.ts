// setPoseLayerState Mutator — set a pose layer's weight / mute / solo (#1927, the layer half of
// the stack's pose row). The agent counterpart of the layer footer's controls: `weight` (the
// layer's blend strength over the pose that arrives, 0..1), `mute` (bypass the whole layer), `solo`
// (play this layer alone — every non-solo layer is silent while one is soloed). Provide ≥1 field.
//
// read == render: layerView shows the FOLDED weight the pose fold uses (poseLayerWeightOf), so a
// set here moves the row and the drawn pose together. The member curves are untouched — this sets
// the layer-level blend state, not a key.
//
// Distinct from setPoseMemberMode (a MEMBER's rotation mode) and setTrackState (an NLA Track) by
// requiredNodeTypes:['PoseLayer'] — the honest V14 signature discriminator. Mirrors setTrackState:
// one setParam per provided field on a distinct paramPath, targeting the layer itself (a closure
// root), re-guarded ≥1 field.
//
// REF: src/nodes/PoseLayer.ts (weight/mute/solo; poseLayerWeightOf — the render's own read);
//      src/app/layerView.ts (PoseRowView — the row this sets); issues #1927, #1241, #1215.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const SetPoseLayerStateSpec = z
  .object({
    /** The PoseLayer whose state to set. */
    layerId: z.string().min(1),
    /** The layer's blend strength over the pose that arrives (0..1). */
    weight: z.number().min(0).max(1).optional(),
    /** Bypass the whole layer. */
    mute: z.boolean().optional(),
    /** Play this layer alone — every non-solo layer is silent while one is soloed (#1241). */
    solo: z.boolean().optional(),
  })
  .refine((s) => s.weight !== undefined || s.mute !== undefined || s.solo !== undefined, {
    message: 'provide at least one of weight / mute / solo.',
  });
export type SetPoseLayerStateSpec = z.infer<typeof SetPoseLayerStateSpec>;

export const setPoseLayerStateMutator: MutatorDefinition<SetPoseLayerStateSpec> = {
  name: 'mutator.pose.setPoseLayerState',
  description:
    'Set a pose layer state: weight (blend strength over the arriving pose, 0..1), mute (bypass ' +
    'the whole layer), solo (play this layer alone — every non-solo layer is silent while one is ' +
    'soloed). Provide at least one field; the others are left unchanged.',
  spec: SetPoseLayerStateSpec,
  specExample: {
    layerId: 'pose_layer_1',
    weight: 0.5,
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['PoseLayer'],
    // Reweighting / muting / soloing a layer changes the fold result but no existing scene aspect
    // is directly rewritten (the member curves are untouched). All 8 preserved; the honest
    // discriminator vs setPoseMemberMode / setTrackState is requiredNodeTypes:['PoseLayer'].
    preserves: [
      'position',
      'rotation',
      'scale',
      'animation',
      'children',
      'material',
      'animation-shape',
      'keyframe-density',
    ],
    lossy: [
      {
        kind: 'prior-pose-layer-state',
        reason: 'replaces the layer weight/mute/solo; the prior layer state no longer renders.',
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.layerId], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const layer = state.nodes[spec.layerId];
    if (!layer) return { ok: false, reason: `layerId "${spec.layerId}" not in DAG.` };
    if (layer.type !== 'PoseLayer') {
      return {
        ok: false,
        reason: `layerId "${spec.layerId}" is ${layer.type}; expected a PoseLayer node.`,
      };
    }
    // Defense-in-depth vs the spec `.refine()` (fires only at safeParse): an all-undefined spec on
    // the validatePlan-direct path would emit empty ops (a silent no-op).
    if (spec.weight === undefined && spec.mute === undefined && spec.solo === undefined) {
      return { ok: false, reason: 'provide at least one of weight / mute / solo.' };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, _state: DagState): Op[] {
    // One setParam per provided field; deterministic order weight→mute→solo.
    const ops: Op[] = [];
    if (spec.weight !== undefined)
      ops.push({ type: 'setParam', nodeId: spec.layerId, paramPath: 'weight', value: spec.weight });
    if (spec.mute !== undefined)
      ops.push({ type: 'setParam', nodeId: spec.layerId, paramPath: 'mute', value: spec.mute });
    if (spec.solo !== undefined)
      ops.push({ type: 'setParam', nodeId: spec.layerId, paramPath: 'solo', value: spec.solo });
    return ops;
  },
};
