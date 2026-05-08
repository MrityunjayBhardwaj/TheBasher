// Identify types — the contract between the orchestrator's pre-Plan
// stage and the agent.identify tool.
//
// IdentifyResult is a discriminated union over three outcomes:
//   - 'match'     — confidence ≥ 0.7, selectors are committed to Plan
//                    rounds via the user-facing follow-up message.
//   - 'ambiguous' — multiple candidates (or low confidence). Orchestrator
//                    surfaces the candidate list to the user and ends
//                    the turn. The user picks; next turn references
//                    the chosen one.
//   - 'no-match'  — query couldn't be resolved. Orchestrator surfaces
//                    the rationale and ends the turn.
//
// REF: P2.5.2 PLAN §5 Wave B; vyapti V13 (closure preservation gates
// against the wrong target — Identify prevents the wrong target from
// being chosen in the first place).

import type { NodeId, NodeTypeId } from '../../core/dag/types';

export type IdentifyResult =
  | {
      type: 'match';
      /** Derived from candidate count + type match (P-6 mitigation). */
      confidence: number;
      /** Concrete node ids the orchestrator commits to. */
      selectors: NodeId[];
      /** One-line explanation of how the match was made. */
      rationale: string;
      /** Which strategy produced the match — for telemetry / debugging. */
      strategy: IdentifyStrategy;
    }
  | {
      type: 'ambiguous';
      /** All candidates considered. Orchestrator presents these to the user. */
      candidates: Candidate[];
      rationale: string;
    }
  | {
      type: 'no-match';
      rationale: string;
    };

export interface Candidate {
  id: NodeId;
  /** Node type, surfaced so the user/LLM can disambiguate ("the BoxMesh, not the SphereMesh"). */
  nodeType: NodeTypeId;
  /** Optional one-line summary derived from params (e.g. "color #ff0000, position [0,1,0]"). */
  summary?: string;
}

export interface IdentifyArgs {
  /**
   * The user's reference phrase. e.g. "the green cube", "selected",
   * "the testimonial text". Lowercased + tokenized internally; raw
   * input preserved for rationale construction.
   */
  query: string;
  /**
   * Affects the ambiguity threshold:
   *   - 'unique'           — caller expects ONE selector; ambiguity above 1 is reported.
   *   - 'multiple-allowed' — caller is fine with N selectors (e.g. "all cubes").
   * Default is 'unique'.
   */
  hint?: 'unique' | 'multiple-allowed';
  /** Optional type filter — restrict candidates to specific node types. */
  filter?: { types?: NodeTypeId[] };
}

/**
 * Strategy used to produce a match. Order matches the dispatch order
 * inside identify.ts — first strategy to produce candidates wins.
 */
export type IdentifyStrategy =
  | 'exact-id'
  | 'selection'
  | 'type-filter'
  | 'color-match'
  | 'param-match';
