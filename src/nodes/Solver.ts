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
import type { Vec3 } from './types';
import { TransformSourceSchema } from './ParamDriver';

const NUMBER_OUT = { out: { type: 'Number', cardinality: 'single' } } as const;
const VECTOR3_OUT = { out: { type: 'Vector3', cardinality: 'single' } } as const;
const ORIGIN: Vec3 = [0, 0, 0];

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

// ── PrevFrameVec / SolverInputVec — the VEC recurrence/input leaves (S, #300) ──
//
// The Vector3 twins of PrevFrame/SolverInput, for a TUPLE-state Solver (a 2nd-order
// spring's state is TWO Vec3s: position + velocity). A tuple Solver carries a Vec3[]
// state; PrevFrameVec's `slot` selects WHICH component it feeds back (slot 0 = position,
// slot 1 = velocity, …), so one sub-network can read every state component. SolverInputVec
// is the live target vector (the controller's whole position, the F2b Point road). Both
// are 0-vec leaves here — the replay seam injects the real Vec3 per frame (overrides).

// PrevFrameVec carries a `slot` (which state component it reads back).
export const PrevFrameVecParams = z.object({
  slot: z.number().int().min(0).default(0),
});
export type PrevFrameVecParams = z.infer<typeof PrevFrameVecParams>;

export const PrevFrameVecNode: NodeDefinition<PrevFrameVecParams, Vec3> = {
  type: 'PrevFrameVec',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: PrevFrameVecParams,
  inputs: {},
  outputs: VECTOR3_OUT,
  // Origin outside replay; the seam overrides with prevState[slot] each frame.
  evaluate: () => ORIGIN,
};

export const SolverInputVecNode: NodeDefinition<LeafParams, Vec3> = {
  type: 'SolverInputVec',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LeafParams,
  inputs: {},
  outputs: VECTOR3_OUT,
  // Origin outside replay; the seam injects the live target vector each frame.
  evaluate: () => ORIGIN,
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
  /** S (#300) — the VEC live input for a TUPLE-state Solver: a controller's WHOLE
   *  evaluated position (the F2b Point road), injected into SolverInputVec leaves as
   *  the target vector (a spring's rest target). Present ⇒ the vec/tuple replay path.
   *  Optional so a scalar Solver serializes byte-identical. */
  sourceTransformVec: z.object({ node: z.string() }).optional(),
});
export type SolverParams = z.infer<typeof SolverParams>;

export const SolverNode: NodeDefinition<SolverParams, { out: number; outVec: Vec3 }> = {
  type: 'Solver',
  version: 1,
  // Not point-in-time reproducible — the real value needs the interval + the previous
  // output, produced by the replay seam (statefulOps.ts). This flag routes it there.
  pure: false,
  stateful: true,
  cost: 'medium',
  paramSchema: SolverParams,
  // `body` = the SCALAR sub-network's OUTPUT node (the last compute node of the loop
  // rule). `bodies` = the VEC/TUPLE outputs, one per state slot (slot i ← bodies[i]),
  // for a tuple Solver (a spring: bodies[0]=new position, bodies[1]=new velocity). The
  // seam cooks the wired one's closure per frame, injecting Prev_Frame(Vec)/SolverInput(Vec).
  // Wired, so the render subscription + cycle guard walk them.
  inputs: {
    body: { type: 'Number', cardinality: 'single' },
    bodies: { type: 'Vector3', cardinality: 'list' },
  },
  // Two output faces: `out` (Number, the scalar Solver) + `outVec` (Vector3, slot 0 of a
  // tuple Solver — the position a spring drives). A driver reads whichever matches its
  // target; the real integrated value comes from the replay seam, this is the degenerate
  // point-in-time passthrough (Prev_Frame/SolverInput read 0/origin here).
  outputs: {
    out: { type: 'Number', cardinality: 'single' },
    outVec: { type: 'Vector3', cardinality: 'single' },
  },
  evaluate: (_params, inputs) => {
    const bodies = inputs.bodies as Vec3[] | undefined;
    const outVec = bodies && bodies.length > 0 && isVec3(bodies[0]) ? bodies[0] : ORIGIN;
    return { out: (inputs.body as number | undefined) ?? 0, outVec };
  },
};

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
}
