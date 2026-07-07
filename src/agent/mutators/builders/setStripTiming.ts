// setStripTiming Mutator — retime a placed Strip (NLA, epic #283 Phase 4).
//
// The agent counterpart of editing a Strip's placement in the NLA UI: `start` (global
// seconds where the Action's t=0 lands), `timeScale` (>1 = slower), `repeat` (≥1 clip
// loops), `reverse`. The Action SOURCE is never rewritten — all placement edits live
// on the Strip (I-1). Provide at least one field.
//
// Sibling of `setStripBlend`: they share the contract tuple `{[], ['Strip'], ALL-8}`
// and are separated ONLY by their `lossy` kind — `prior-strip-timing` here vs
// `prior-strip-blend` there. That is the HONEST V14 discriminator (timing vs blend are
// genuinely different placement concerns), not a gamed token.
//
// Mirrors setChannelExtend.ts (setParam-emitting, re-guarded): one setParam per
// provided field on a distinct paramPath, targeting the Strip itself (a closure root).
//
// REF: src/nodes/Strip.ts (the placement fields); src/app/stripRetime.ts (remapStripTime
//      — what these fields drive); vyapti V14/V57/V88 D2; docs/NLA-DESIGN.md §3.3.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const SetStripTimingSpec = z
  .object({
    /** The Strip whose placement to retime. */
    stripId: z.string().min(1),
    /** Global start time (seconds) where the Action's t=0 lands. */
    start: z.number().optional(),
    /** Playback rate: >1 = slower (stretches the Action over more time). */
    timeScale: z.number().positive().optional(),
    /** How many times the Action clip repeats within the placement (≥1). */
    repeat: z.number().min(1).optional(),
    reverse: z.boolean().optional(),
  })
  .refine(
    (s) =>
      s.start !== undefined ||
      s.timeScale !== undefined ||
      s.repeat !== undefined ||
      s.reverse !== undefined,
    { message: 'provide at least one of start / timeScale / repeat / reverse.' },
  );
export type SetStripTimingSpec = z.infer<typeof SetStripTimingSpec>;

export const setStripTimingMutator: MutatorDefinition<SetStripTimingSpec> = {
  name: 'mutator.nla.setStripTiming',
  description:
    'Retime a placed Strip: start (global seconds where the Action t=0 lands), ' +
    'timeScale (>1 slower), repeat (≥1 clip repeats), reverse. Provide at least one ' +
    'field; the others are left unchanged. The Action source is untouched — only this ' +
    "strip's placement changes. For blend/influence, use mutator.nla.setStripBlend.",
  spec: SetStripTimingSpec,
  specExample: {
    stripId: 'nla_strip_1',
    start: 1,
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['Strip'],
    // Retiming the placement changes no existing scene aspect of the target directly —
    // it re-places an already-animated strip. All 8 aspects are preserved; the honest
    // discriminator vs setStripBlend (which shares this preserves-set) is the lossy kind.
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
        kind: 'prior-strip-timing',
        reason:
          'replaces the strip placement; the prior retime (start/scale/repeat/reverse) no longer renders.',
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
    // Defense-in-depth vs the spec `.refine()` (fires only at safeParse): a
    // validatePlan-direct caller with no field set would emit empty ops (a silent no-op).
    if (
      spec.start === undefined &&
      spec.timeScale === undefined &&
      spec.repeat === undefined &&
      spec.reverse === undefined
    ) {
      return { ok: false, reason: 'provide at least one of start / timeScale / repeat / reverse.' };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, _state: DagState): Op[] {
    // One setParam per provided field; deterministic order start→timeScale→repeat→reverse.
    const ops: Op[] = [];
    if (spec.start !== undefined)
      ops.push({ type: 'setParam', nodeId: spec.stripId, paramPath: 'start', value: spec.start });
    if (spec.timeScale !== undefined)
      ops.push({
        type: 'setParam',
        nodeId: spec.stripId,
        paramPath: 'timeScale',
        value: spec.timeScale,
      });
    if (spec.repeat !== undefined)
      ops.push({ type: 'setParam', nodeId: spec.stripId, paramPath: 'repeat', value: spec.repeat });
    if (spec.reverse !== undefined)
      ops.push({
        type: 'setParam',
        nodeId: spec.stripId,
        paramPath: 'reverse',
        value: spec.reverse,
      });
    return ops;
  },
};
