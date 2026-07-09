// setStripBlend Mutator — set a placed Strip's blend (NLA, epic #283 Phase 4).
//
// The agent counterpart of editing a Strip's blend in the NLA UI: `blendMode`
// (replace / combine), `influence` [0,1] (static weight), and the crossfade ramps
// `blendIn` / `blendOut` (seconds → TIME-VARYING influence 0→full / full→0, the
// Phase-3 seam). The Action source is untouched — the blend lives on the Strip (I-1).
// Provide at least one field.
//
// Sibling of `setStripTiming`: they share the contract tuple `{[], ['Strip'], ALL-8}`
// and are separated ONLY by their `lossy` kind — `prior-strip-blend` here vs
// `prior-strip-timing` there. The honest V14 discriminator (blend vs timing are
// genuinely different placement concerns), not a gamed token.
//
// REF: src/nodes/Strip.ts (blendMode/influence/blendIn/blendOut); src/app/layeredChannels.ts
//      (syntheticChannelValue — where blendIn/blendOut become an influenceAt ramp);
//      vyapti V14/V57/V88 I-7; docs/NLA-DESIGN.md §3.3.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { CHANNEL_BLEND_MODES } from '../../../nodes/types';

const SetStripBlendSpec = z
  .object({
    /** The Strip whose blend to set. */
    stripId: z.string().min(1),
    blendMode: z.enum(CHANNEL_BLEND_MODES).optional(),
    /** Static influence ∈ [0,1]. */
    influence: z.number().min(0).max(1).optional(),
    /** Lead-in crossfade ramp (seconds): influence 0→full over [start, start+blendIn]. */
    blendIn: z.number().min(0).optional(),
    /** Lead-out crossfade ramp (seconds): full→0 over [end-blendOut, end]. */
    blendOut: z.number().min(0).optional(),
  })
  .refine(
    (s) =>
      s.blendMode !== undefined ||
      s.influence !== undefined ||
      s.blendIn !== undefined ||
      s.blendOut !== undefined,
    { message: 'provide at least one of blendMode / influence / blendIn / blendOut.' },
  );
export type SetStripBlendSpec = z.infer<typeof SetStripBlendSpec>;

export const setStripBlendMutator: MutatorDefinition<SetStripBlendSpec> = {
  name: 'mutator.nla.setStripBlend',
  description:
    'Set a placed Strip blend: blendMode (replace / combine), influence [0,1] ' +
    '(static weight), blendIn / blendOut crossfade ramps (seconds → time-varying ' +
    'influence 0→full / full→0). Provide at least one field; the others are left ' +
    'unchanged. The Action source is untouched. For placement timing, use ' +
    'mutator.nla.setStripTiming.',
  spec: SetStripBlendSpec,
  specExample: {
    stripId: 'nla_strip_1',
    blendIn: 0.5,
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['Strip'],
    // Setting the blend changes no existing scene aspect directly — it reweights an
    // already-animated strip. All 8 aspects preserved; the honest discriminator vs
    // setStripTiming (which shares this preserves-set) is the lossy kind.
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
        kind: 'prior-strip-blend',
        reason: 'replaces the strip blend; the prior influence / crossfade ramp no longer renders.',
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.stripId], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const strip = state.nodes[spec.stripId];
    if (!strip) return { ok: false, reason: `stripId "${spec.stripId}" not in DAG.` };
    if (strip.type !== 'Strip') {
      return {
        ok: false,
        reason: `stripId "${spec.stripId}" is ${strip.type}; expected a Strip node.`,
      };
    }
    // Defense-in-depth vs the spec `.refine()` (fires only at safeParse): an
    // all-undefined spec on the validatePlan-direct path would emit empty ops.
    if (
      spec.blendMode === undefined &&
      spec.influence === undefined &&
      spec.blendIn === undefined &&
      spec.blendOut === undefined
    ) {
      return {
        ok: false,
        reason: 'provide at least one of blendMode / influence / blendIn / blendOut.',
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, _state: DagState): Op[] {
    // One setParam per provided field; order blendMode→influence→blendIn→blendOut.
    const ops: Op[] = [];
    if (spec.blendMode !== undefined)
      ops.push({
        type: 'setParam',
        nodeId: spec.stripId,
        paramPath: 'blendMode',
        value: spec.blendMode,
      });
    if (spec.influence !== undefined)
      ops.push({
        type: 'setParam',
        nodeId: spec.stripId,
        paramPath: 'influence',
        value: spec.influence,
      });
    if (spec.blendIn !== undefined)
      ops.push({
        type: 'setParam',
        nodeId: spec.stripId,
        paramPath: 'blendIn',
        value: spec.blendIn,
      });
    if (spec.blendOut !== undefined)
      ops.push({
        type: 'setParam',
        nodeId: spec.stripId,
        paramPath: 'blendOut',
        value: spec.blendOut,
      });
    return ops;
  },
};
