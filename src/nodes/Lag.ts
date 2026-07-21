// Lag — the first stateful op (Epic 2, #297). The Basher analogue of Houdini's
// Lag CHOP: a stateful node inserted in the pull chain that low-passes its input,
// so the output "trails" the input instead of snapping to it (the memoryless case).
//
// WHY it can't be a plain compute node: a stateless node's value at frame N is a
// pure function of N. Lag's value at N depends on its OWN value at N−1 (a first-
// order recurrence `out = out + (in − out)·factor`, `valueMath.lagStep`). The pure
// evaluator sees one point in time and has no previous output to thread — so the
// real value CANNOT be produced here. This node therefore declares `stateful: true`
// and its `evaluate` is a PASSTHROUGH of its input (a degenerate, un-lagged value,
// used only if something reads it point-in-time). The real, integrated value is
// produced by the replay seam (src/app/statefulOps.ts), which threads the previous
// output forward from a known seed over the frame interval and folds a channel value
// whose `sample(t)` re-integrates deterministically — so a scrub replays the same
// interval and lands the same value (H40 by contract, not by purity).
//
// Scope (v1): scalar ('Number'), and driven through a ParamDriver whose `in` is
// wired directly to this node (the seam detects the direct stateful source). Spring
// (2nd-order) is the next preset on this same contract; chains of stateful nodes and
// a controller feeding a stateful `in` are later generalizations.
//
// REF: Houdini Lag CHOP (https://www.sidefx.com/docs/houdini/nodes/chop/lag.html);
//      GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §5/§5a; valueMath.lagStep;
//      src/app/statefulOps.ts (the replay seam); issue #297.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import { TransformSourceSchema } from './ParamDriver';

export const LagParams = z.object({
  /** Fraction of the gap to the input closed per frame, ∈ [0,1]: 1 = no lag
   *  (snaps), →0 = heavy lag. Clamped in `lagStep`. */
  factor: z.number().default(0.2),
  /** The frame the recurrence is seeded from (out[seedFrame] = in[seedFrame]).
   *  The interval [seedFrame, currentFrame] is what the seam re-integrates. */
  seedFrame: z.number().int().default(0),
  /** The input the lag trails: one TRANSFORM CHANNEL of a controller (an animated
   *  Null) — the same "Transform Channel" road the driver uses (#296), reused so the
   *  replay reads a genuinely time-varying scalar (a wired compute `in` is
   *  time-invariant). ABSENT = fall back to the wired `in` (converges to a constant).
   *  The replay seam (statefulOps.ts) samples this per frame; optional so a bare Lag
   *  serializes byte-identical. */
  sourceTransform: TransformSourceSchema.optional(),
});
export type LagParams = z.infer<typeof LagParams>;

export const LagNode: NodeDefinition<LagParams, number> = {
  type: 'Lag',
  version: 1,
  // Not point-in-time reproducible: the true value needs the interval (see header).
  // The seam produces the real value; this flag tells it to replay rather than read
  // the passthrough `evaluate` below.
  pure: false,
  stateful: true,
  cost: 'cheap',
  paramSchema: LagParams,
  // #421 — the controller is a shared object; clear the nested id (keeping
  // `channel`) rather than deleting the Lag node.
  idRefs: [{ path: 'sourceTransform.node', shape: 'nested', role: 'argument' }],
  inputs: { in: { type: 'Number', cardinality: 'single' } },
  outputs: { out: { type: 'Number', cardinality: 'single' } },
  // Passthrough of the input — the degenerate un-lagged value. The integrated value
  // is computed by the replay seam (statefulOps.ts); this exists so a point-in-time
  // read never crashes and returns something sane (the current input).
  evaluate: (_params, inputs) => (inputs.in as number | undefined) ?? 0,
};
