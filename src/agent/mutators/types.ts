// Mutator types — semantic operations on the DAG that compose Op[]
// chains under explicit closure declarations and shape preconditions.
//
// A Mutator is the bridge between LLM intent ("rotate this 45 degrees")
// and the Op vocabulary the dispatcher accepts. It declares:
//   - spec:               zod-validated arg shape
//   - contract:           required edge kinds, required node types,
//                         what the mutation preserves, what it loses
//   - buildClosureSpec:   declaratively expand its scope (Wave A's
//                         ClosureSpec — vyapti V13)
//   - preconditions:      shape-only check (P-5: not semantic state)
//   - build:              produces Op[] from spec + closure + dagState
//
// Five gates run on every plan (validate.ts). Each rejection also carries
// a `label` discriminator — gate numbers are aggregate categories; labels
// name the specific check that fired:
//   gate 1: structural contract checks
//     - 'contract_edges'   — buildClosureSpec covers contract.requiredEdges
//     - 'node_existence'   — every op targets a known node OR fresh addNode
//   gate 2: 'param_schema' — setParam value parses against paramSchema
//   gate 3: 'closure_preservation' — every op stays inside the declared closure (V13)
//   gate 4: contract+state preconditions
//     - 'precondition'     — Mutator.preconditions() (shape-only, P-5)
//     - 'contract_scope'   — closure contains every contract.requiredNodeTypes type
//   gate 5: build/adapter
//     - 'build_exception'  — Mutator.build() threw
//     - 'adapter_fidelity' — P7 stub (always passes today)
//
// Labels are stable; gate numbers remain for backward-compat retry policies.
//
// REF: P2.5.2 PLAN §5 Wave C; vyapti V13 (closure), V14 (non-redundancy).

import type { z } from 'zod';
import type { ClosureSet, ClosureSpec, EdgeKind } from '../closure/types';
import type { DagState } from '../../core/dag/state';
import type { NodeTypeId, Op } from '../../core/dag/types';

/**
 * What the Mutator's mutation preserves about each affected node. Used
 * for plan-level previews ("rotate preserves position + scale + material").
 */
export type PreservedAspect =
  | 'rotation'
  | 'position'
  | 'scale'
  | 'animation'
  | 'children'
  | 'material';

export interface LossyAspect {
  kind: string;
  reason: string;
}

export interface MutatorContract {
  /** Edge kinds the closure walker follows from each root selector. */
  requiredEdges: EdgeKind[];
  /**
   * At least one node of each listed type must be inside the resolved
   * closure for the mutator to apply. Empty array means "no type
   * requirement" (mutator works on any node).
   */
  requiredNodeTypes: NodeTypeId[];
  /** What survives unchanged through this mutation. */
  preserves: PreservedAspect[];
  /** Optional: explicit losses (e.g. duplicate may not preserve unique pose). */
  lossy?: LossyAspect[];
}

export type PreconditionResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface MutatorDefinition<Spec = unknown> {
  /** Tool-call name (LLM surface). */
  name: string;
  description: string;
  /** Zod schema for the spec arg. Validated by gate 2 + at the tool boundary. */
  spec: z.ZodType<Spec, z.ZodTypeDef, unknown>;
  contract: MutatorContract;
  /**
   * Build the closure expansion spec for this mutator's spec. The
   * five-gate validator passes the result to expandClosure and feeds
   * the resulting ClosureSet into preconditions + build.
   */
  buildClosureSpec(spec: Spec): ClosureSpec;
  /**
   * Shape-only check. Fires AFTER closure is expanded; verifies the
   * scope contains the required nodes/edges. Per P-5 mitigation:
   * does NOT check semantic state (e.g. "Navmesh has obstacles") —
   * those are build-time invariants.
   */
  preconditions(spec: Spec, closure: ClosureSet, state: DagState): PreconditionResult;
  /**
   * Compose Op[] from the spec + already-validated closure + current
   * DAG state. Pure — no I/O, no DAG mutation. Errors thrown here
   * surface as gate-5 failures.
   */
  build(spec: Spec, closure: ClosureSet, state: DagState): Op[];
}

/**
 * The successful output of the five-gate validator: the ops to propose
 * + the resolved closure + the human-readable intent the LLM gave +
 * any non-fatal warnings (e.g. "this duplicate will lose pose data").
 */
export interface MutatorPlan {
  ok: true;
  mutator: string;
  ops: Op[];
  closure: ClosureSet;
  intent: string;
  warnings: string[];
}

/**
 * Stable per-check identifier. Multiple labels can map to the same gate
 * number — see types.ts header for the mapping. Telemetry + retry policies
 * key on `label` for precision; existing consumers can stay on `gate`.
 */
export type RejectionLabel =
  | 'contract_edges'
  | 'node_existence'
  | 'param_schema'
  | 'closure_preservation'
  | 'precondition'
  | 'contract_scope'
  | 'build_exception'
  | 'adapter_fidelity';

/**
 * Structured rejection. `gate` identifies which gate category fired (1-5);
 * `label` names the specific check (stable across releases). `reason` is
 * human-readable. The orchestrator threads this back to the LLM as a
 * tool result so the model can retry, refine, or surface to the user.
 */
export interface MutatorRejection {
  ok: false;
  mutator: string;
  gate: 1 | 2 | 3 | 4 | 5;
  label: RejectionLabel;
  reason: string;
}

export type MutatorValidationResult = MutatorPlan | MutatorRejection;
