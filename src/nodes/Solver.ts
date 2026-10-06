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
// The vocabulary is ONE owner and its named inputs (#1548):
//   • Solver        — the meta-op. Its `body` input is wired to the sub-network's
//                     OUTPUT node; the seam cooks that node's dependency closure once
//                     per frame. It DECLARES the sub-network's named inputs
//                     (`bodyInputs`): `prev` (Houdini `Prev_Frame`, the solver's output
//                     from the previous frame), `input` (Houdini `Input_1`, its live
//                     input at the current frame), and their vector twins.
//   • BodyInput     — a leaf that reads one of those inputs BY NAME (a Number);
//     BodyInputVec    the Vector3 twin. Nothing about them is Solver-specific: the Rig
//                     and Template nodes declare their own names and use the same leaves.
//                     The seam binds a value to each name per frame
//                     (`bindBodyInputs`, src/core/dag/subnetworks.ts).
//
// Outside a cook the leaves are harmless 0 / origin leaves — the seam is the ONLY place
// they take meaning, exactly as Lag's integrated value lives only in the seam and never
// in its passthrough `evaluate`.
//
// Lag-parity (the engine proof): a sub-network of ONE `Mix{a←prev, b←input}`
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
import { widget } from './paramWidget';

const NUMBER_OUT = { out: { type: 'Number', cardinality: 'single' } } as const;
const VECTOR3_OUT = { out: { type: 'Vector3', cardinality: 'single' } } as const;
const ORIGIN: Vec3 = [0, 0, 0];

// ── BodyInput / BodyInputVec — the named-input leaves (#1548) ─────────────────
//
// A leaf that stands for the owner's input named by its `input` param; `slot` picks one element of a `list`
// input (a tuple Solver's `prevVec`: slot 0 = position, slot 1 = velocity). The value is
// bound by the owner's seam per cook; outside one the leaf reads its default.
//
// Two types, not one, because a node's output type is fixed per type and `connect`
// checks it: a Number leaf can't feed a Vector3 socket. They replace PrevFrame,
// SolverInput, PrevFrameVec and SolverInputVec, which a v21 project migrates to
// (`migrateSolverLeavesToBodyInputs`, src/core/project/migrations.ts).
export const BodyInputParams = z.object({
  input: widget('text', z.string().min(1).default('input')),
  slot: z.number().int().min(0).default(0),
});
export type BodyInputParams = z.infer<typeof BodyInputParams>;

export const BodyInputNode: NodeDefinition<BodyInputParams, number> = {
  type: 'BodyInput',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BodyInputParams,
  inputs: {},
  outputs: NUMBER_OUT,
  bodyInputLeaf: true,
  evaluate: () => 0,
};

export const BodyInputVecNode: NodeDefinition<BodyInputParams, Vec3> = {
  type: 'BodyInputVec',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BodyInputParams,
  inputs: {},
  outputs: VECTOR3_OUT,
  bodyInputLeaf: true,
  evaluate: () => ORIGIN,
};

// ── Solver — the stateful meta-op ─────────────────────────────────────────────
export const SolverParams = z.object({
  /** The frame the recurrence is seeded from: on the seed frame Prev_Frame = the
   *  live input at this frame (Houdini's Input_1-seeds-Prev_Frame; Lag's seed rule).
   *  The interval [seedFrame, currentFrame] is what the seam re-cooks. */
  seedFrame: z.number().int().default(0),
  /** The live per-frame input the sub-network reads as `input`:
   *  one TRANSFORM CHANNEL of a controller (an animated Null), the same road Lag and
   *  the #296 driver use — so the replay reads a genuinely time-varying scalar (a
   *  wired compute graph is time-invariant). ABSENT = the live input reads 0 (a pure
   *  feedback solver). Optional so a bare Solver serializes byte-identical. */
  sourceTransform: TransformSourceSchema.optional(),
  /** S (#300) — the VEC live input for a TUPLE-state Solver: a controller's WHOLE
   *  evaluated position (the F2b Point road), bound to `inputVec` as
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
  // #421 — both source roads point at a shared controller node; clear, never
  // delete. `sourceTransform` clears the nested id so `channel` survives.
  idRefs: [
    { path: 'sourceTransform.node', shape: 'nested', role: 'argument' },
    { path: 'sourceTransformVec', shape: 'ref', role: 'argument' },
  ],
  // The live controller (a spring's rest target) is authored through the general node-ref
  // picker in the inspector — the same control SampleGeometry uses, not a bespoke road.
  refParams: { sourceTransformVec: { label: 'controller', kind: 'transformable' } },
  // `body` = the SCALAR sub-network's OUTPUT node (the last compute node of the loop
  // rule). `bodies` = the VEC/TUPLE outputs, one per state slot (slot i ← bodies[i]),
  // for a tuple Solver (a spring: bodies[0]=new position, bodies[1]=new velocity). The
  // seam cooks the wired one's closure per frame, binding the named inputs below.
  // Wired, so the render subscription + cycle guard walk them. #1547 — both are BODY
  // sockets: the closure behind them is this Solver's sub-network, and nothing in it may
  // feed anything outside it (`src/core/dag/subnetworks.ts`).
  inputs: {
    body: { type: 'Number', cardinality: 'single', body: true },
    bodies: { type: 'Vector3', cardinality: 'list', body: true },
  },
  // Two output faces: `out` (Number, the scalar Solver) + `outVec` (Vector3, slot 0 of a
  // tuple Solver — the position a spring drives). A driver reads whichever matches its
  // target; the real integrated value comes from the replay seam, this is the degenerate
  // point-in-time passthrough (the body-input leaves read 0/origin here).
  outputs: {
    out: { type: 'Number', cardinality: 'single' },
    outVec: { type: 'Vector3', cardinality: 'single' },
  },
  // #1548 — the sub-network's named inputs. `prev`/`input` feed the scalar `body`;
  // `prevVec` (one element per state slot) and `inputVec` feed the tuple `bodies`.
  bodyInputs: {
    prev: { type: 'Number', cardinality: 'single' },
    input: { type: 'Number', cardinality: 'single' },
    prevVec: { type: 'Vector3', cardinality: 'list' },
    inputVec: { type: 'Vector3', cardinality: 'single' },
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
