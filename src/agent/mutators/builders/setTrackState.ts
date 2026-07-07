// setTrackState Mutator — set a Track's order / mute / solo (NLA, epic #283 Phase 4).
//
// The agent counterpart of the NLA track controls: `order` (cross-track fold rank,
// bottom→top — reordering CHANGES the fold result, I-2), `mute` (bypass the whole
// track), `solo` (silence every non-solo track, global). Provide at least one field.
//
// Distinct from the set-Strip family (setStripTiming/setStripBlend) by
// `requiredNodeTypes:['Track']` — the honest V14 signature discriminator (it operates on
// a Track, not a Strip). Mirrors setChannelExtend.ts: one setParam per provided field on
// a distinct paramPath, targeting the Track itself (a closure root), re-guarded ≥1 field.
//
// REF: src/nodes/Track.ts (order/mute/solo); src/app/layeredChannels.ts (activeTracksSorted
//      — order/solo/mute drive the fold); vyapti V14/V57/V88 D2 I-2; docs/NLA-DESIGN.md §3.3.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const SetTrackStateSpec = z
  .object({
    /** The Track whose state to set. */
    trackId: z.string().min(1),
    /** Cross-track fold rank (bottom→top). Reordering changes the fold result (I-2). */
    order: z.number().optional(),
    /** Bypass the whole track. */
    mute: z.boolean().optional(),
    /** Solo on ANY track silences every non-solo track (global). */
    solo: z.boolean().optional(),
  })
  .refine((s) => s.order !== undefined || s.mute !== undefined || s.solo !== undefined, {
    message: 'provide at least one of order / mute / solo.',
  });
export type SetTrackStateSpec = z.infer<typeof SetTrackStateSpec>;

export const setTrackStateMutator: MutatorDefinition<SetTrackStateSpec> = {
  name: 'mutator.nla.setTrackState',
  description:
    'Set a Track state: order (cross-track fold rank, bottom→top — reordering changes ' +
    'the fold result), mute (bypass the whole track), solo (silence every non-solo ' +
    'track, global). Provide at least one field; the others are left unchanged.',
  spec: SetTrackStateSpec,
  specExample: {
    trackId: 'nla_track_1',
    mute: true,
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['Track'],
    // Setting track state reweights/reorders already-authored strips — no existing scene
    // aspect is directly changed. All 8 preserved; the honest discriminator vs the
    // set-Strip family is requiredNodeTypes:['Track'], and the lossy kind records the loss.
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
        kind: 'prior-track-state',
        reason: 'replaces the track order/mute/solo; the prior track state no longer renders.',
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.trackId], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const track = state.nodes[spec.trackId];
    if (!track) return { ok: false, reason: `trackId "${spec.trackId}" not in DAG.` };
    if (track.type !== 'Track') {
      return {
        ok: false,
        reason: `trackId "${spec.trackId}" is ${track.type}; expected a Track node.`,
      };
    }
    // Defense-in-depth vs the spec `.refine()` (fires only at safeParse): an all-undefined
    // spec on the validatePlan-direct path would emit empty ops (a silent no-op).
    if (spec.order === undefined && spec.mute === undefined && spec.solo === undefined) {
      return { ok: false, reason: 'provide at least one of order / mute / solo.' };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, _state: DagState): Op[] {
    // One setParam per provided field; deterministic order order→mute→solo.
    const ops: Op[] = [];
    if (spec.order !== undefined)
      ops.push({ type: 'setParam', nodeId: spec.trackId, paramPath: 'order', value: spec.order });
    if (spec.mute !== undefined)
      ops.push({ type: 'setParam', nodeId: spec.trackId, paramPath: 'mute', value: spec.mute });
    if (spec.solo !== undefined)
      ops.push({ type: 'setParam', nodeId: spec.trackId, paramPath: 'solo', value: spec.solo });
    return ops;
  },
};
