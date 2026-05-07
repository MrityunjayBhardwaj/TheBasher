// Confidence derivation (P-6 mitigation).
//
// The model is bad at calibrated self-confidence — left to its own
// devices it emits 0.99 for everything. So confidence is NOT
// model-reported; it's derived from the local match against the DAG:
//
//   - exactly 1 candidate                    → 1.0
//   - 2-3 candidates with consistent type    → 0.6
//   - >3 candidates  OR  type mismatch       → 0.3
//
// The orchestrator's commit threshold is 0.7. So single-candidate matches
// always commit; ambiguous matches always surface to the user.
//
// REF: P2.5.2 PLAN §2 P-6, §5 Wave B step 2.

import type { Candidate } from './types';

export const COMMIT_THRESHOLD = 0.7;

export interface ConfidenceInputs {
  candidates: Candidate[];
  /**
   * True when the query implied a specific node type and at least one
   * candidate matches it (e.g. query "cube" + at least one BoxMesh).
   * False when no type was implied OR when all candidates are wrong-type.
   */
  typeConsistent: boolean;
}

export function deriveConfidence(inputs: ConfidenceInputs): number {
  const n = inputs.candidates.length;
  if (n === 0) return 0;
  if (n === 1) return 1.0;
  if (n <= 3 && inputs.typeConsistent) return 0.6;
  return 0.3;
}

/** Whether the orchestrator should commit on this confidence level. */
export function shouldCommit(confidence: number): boolean {
  return confidence >= COMMIT_THRESHOLD;
}
