// Solver — the meta-op (Epic 2, the 3rd OpNet instance). Houdini's Solver SOP,
// ported to Basher's scalar rail: a node that owns a user-authored SUB-NETWORK
// cooked EVERY FRAME, with the previous frame's output fed back in (`Prev_Frame`)
// plus a seed (`Input_1`). It generalizes Lag's ONE fixed recurrence
// (`out += (in − out)·factor`) to ANY per-frame update rule composed from ordinary
// compute nodes — so Lag/Spring become PRESETS (saved sub-networks), not node types.
//
// WHY it can't be a plain compute node (same reason as Lag): a stateless node's
// value at frame N is a pure function of N. A solver's value at N depends on its OWN
// output at N−1 (an arbitrary recurrence `out(N) = subnetwork(prev=out(N−1),
// input=in(N))`). The pure evaluator sees one frame and has no previous output, so
// the real value CANNOT be produced here. The Solver therefore declares
// `stateful: true`; the replay seam (src/app/statefulOps.ts) re-cooks the sub-network
// forward from a known seed over the frame interval and folds a channel value whose
// `sample(t)` re-integrates deterministically — a scrub replays the same interval and
// lands the same value (H40 by contract, not by purity). Same contract as Lag; only
// the per-frame STEP differs (cook a sub-graph vs. apply `lagStep`).
//
// The vocabulary is THREE node types:
//   • Solver      — the meta-op. Its `body` input is wired to the sub-network's
//                   OUTPUT node; the seam cooks that node's dependency closure once
//                   per frame, threading the previous output back through PrevFrame.
//   • PrevFrame   — the recurrence leaf (Houdini `Prev_Frame`): the solver's output
//                   from the PREVIOUS frame. A pure 0-leaf here; the seam injects the
//                   real value per frame (evaluate `overrides`).
//   • SolverInput — the live-input leaf (Houdini `Input_1`): the solver's live input
//                   at the CURRENT frame (its `sourceTransform` controller channel).
//                   A pure 0-leaf here; the seam injects the value per frame.
//
// Outside a Solver's closure PrevFrame/SolverInput are harmless 0-leaves — the seam
// is the ONLY place they take meaning, exactly as Lag's integrated value lives only
// in the seam and never in its passthrough `evaluate`.
//
// Lag-parity (the engine proof): a sub-network of ONE `Mix{a←PrevFrame, b←SolverInput}`
// is `lerp(prev, in, factor)` == `lagStep` — so a Solver wrapping it must produce the
// byte-identical channel a Lag produces (statefulOps.test).
//
// Scope (v1): SCALAR state (a single Number fed back). Structured/tuple Prev_Frame
// (→ 2nd-order Spring pos+velocity, multi-accumulators) is the next increment on this
// same contract. Nested Solvers (a Solver inside a Solver's closure) are out of scope.
//
// REF: GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §5a (Solver SOP: Prev_Frame +
//      Input_1, cooked every frame); https://www.sidefx.com/docs/houdini/nodes/sop/solver.html;
//      src/app/statefulOps.ts (the replay seam); src/nodes/Lag.ts (the fixed-recurrence
//      sibling this generalizes); valueMath.lagStep; dharana B27; epic #290 (Epic 2).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import { TransformSourceSchema } from './ParamDriver';

const NUMBER_OUT = { out: { type: 'Number', cardinality: 'single' } } as const;

// The sub-network leaves carry no params — their value is injected by the replay seam
// (or 0 outside it). A named empty schema keeps the node-definition types honest.
const LeafParams = z.object({});
type LeafParams = z.infer<typeof LeafParams>;

// ── PrevFrame — the recurrence leaf (Houdini Prev_Frame) ──────────────────────
export const PrevFrameNode: NodeDefinition<LeafParams, number> = {
  type: 'PrevFrame',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LeafParams,
  inputs: {},
  outputs: NUMBER_OUT,
  // 0 outside replay. The replay seam (statefulOps.ts) overrides this node's value
  // with the solver's PREVIOUS-frame output each frame (evaluate `overrides`).
  evaluate: () => 0,
};

// ── SolverInput — the live-input leaf (Houdini Input_1) ───────────────────────
export const SolverInputNode: NodeDefinition<LeafParams, number> = {
  type: 'SolverInput',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LeafParams,
  inputs: {},
  outputs: NUMBER_OUT,
  // 0 outside replay. The seam injects the solver's live input (its sourceTransform
  // controller channel) at the current frame.
  evaluate: () => 0,
};

// ── Solver — the stateful meta-op ─────────────────────────────────────────────
export const SolverParams = z.object({
  /** The frame the recurrence is seeded from: on the seed frame Prev_Frame = the
   *  live input at this frame (Houdini's Input_1-seeds-Prev_Frame; Lag's seed rule).
   *  The interval [seedFrame, currentFrame] is what the seam re-cooks. */
  seedFrame: z.number().int().default(0),
  /** The live per-frame input the sub-network reads through its SolverInput leaves:
   *  one TRANSFORM CHANNEL of a controller (an animated Null), the same road Lag and
   *  the #296 driver use — so the replay reads a genuinely time-varying scalar (a
   *  wired compute graph is time-invariant). ABSENT = the live input reads 0 (a pure
   *  feedback solver). Optional so a bare Solver serializes byte-identical. */
  sourceTransform: TransformSourceSchema.optional(),
});
export type SolverParams = z.infer<typeof SolverParams>;

export const SolverNode: NodeDefinition<SolverParams, number> = {
  type: 'Solver',
  version: 1,
  // Not point-in-time reproducible — the real value needs the interval + the previous
  // output, produced by the replay seam (statefulOps.ts). This flag routes it there.
  pure: false,
  stateful: true,
  cost: 'medium',
  paramSchema: SolverParams,
  // `body` = the sub-network's OUTPUT node (the last compute node of the loop rule).
  // The seam cooks its dependency closure per frame, injecting Prev_Frame/SolverInput.
  // Wired (unlike Lag's unused `in`), so the render subscription + cycle guard walk it.
  inputs: { body: { type: 'Number', cardinality: 'single' } },
  outputs: NUMBER_OUT,
  // Passthrough of the point-in-time sub-network output (Prev_Frame/SolverInput read 0
  // here) — a sane degenerate value if something reads the Solver outside the seam. The
  // real integrated value comes from the replay seam.
  evaluate: (_params, inputs) => (inputs.body as number | undefined) ?? 0,
};
