// UI → Mutator dispatch seam (Phase 7, Wave A).
//
// THE single spine D-05 mandates: a UI gesture (a diamond click, an
// Auto-Key param edit) reaches the DAG through the SAME
// `validatePlan → useDiffStore.propose → acceptSelectedOps →
// dispatchAtomic` chain the agent uses. This is a NEW CALLER of that
// chain — NOT a parallel DAG-mutation path, NOT a bare `addNode` emitter.
//
// Interface depth (Ousterhout): the exported functions take a spec in
// and return applied-or-rejected out. Every Mutator internal
// (getMutator, safeParse, validatePlan, fork-evolve, propose,
// acceptSelectedOps) lives BEHIND this boundary. No ops / closure / fork
// / diff types leak into any exported signature — React components call
// one function and never see the agent layer.
//
// V13 (closure preservation): each propose() is passed the
// Mutator-declared `result.closure.spec` explicitly (mirrors
// orchestrator.ts:457 — the Mutator-declared closure takes precedence
// over any selection-inferred fallback). A1 pre-mortem.
//
// REF: .planning/phases/07-animation-authoring/PLAN.md Wave A;
//      THESIS.md §767/§123 (single spine); vyapti V13.

import { getMutator } from '../../agent/mutators/catalog';
import { validatePlan } from '../../agent/mutators/validate';
import { useDiffStore, acceptSelectedOps } from '../../agent/diff/store';
import { useDagStore } from '../../core/dag/store';
import type { ClosureSpec } from '../../agent/closure/types';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';

export type DispatchResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate ONE Mutator (catalog name + spec) and, on success, propose +
 * immediately accept the ops as a single atomic undo entry.
 *
 * Auto-accept rationale (RESEARCH U3 — PLANNER DECISION): a direct
 * manipulation gesture is not an agent proposal. Blender `I` lands the
 * key instantly. We still run propose() so the V13 closure gate fires
 * with the Mutator-declared spec; only the human DiffBar review step —
 * wrong for direct manipulation — is skipped.
 *
 * Spec shape, closure scope, ops, the fork, the diff store: all hidden.
 * Caller sees `{ ok:true }` or `{ ok:false, reason }`.
 */
export function dispatchMutatorFromUI(
  mutatorName: string,
  spec: unknown,
  intent: string,
): DispatchResult {
  // 1 — node_existence (gate 1, mirror tool.ts:81): unknown name → reject.
  const mutator = getMutator(mutatorName);
  if (!mutator) {
    return {
      ok: false,
      reason: `Unknown mutator "${mutatorName}".`,
    };
  }

  // 2 — param_schema at the boundary (gate 2, mirror tool.ts:93).
  const parsed = mutator.spec.safeParse(spec);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Mutator spec failed schema validation: ${parsed.error.message}`,
    };
  }

  // 3 — the five gates (validate.ts:46) against the LIVE DAG state.
  const state = useDagStore.getState().state;
  const result = validatePlan(mutator, parsed.data, state, intent);

  // 4 — reject: leave the DAG byte-unchanged. NO mutation.
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  // 5 — propose with the MUTATOR-DECLARED closure spec (V13; A1
  //     pre-mortem — never the selection-inferred fallback), then
  //     IMMEDIATELY accept → one dispatchAtomic → one Cmd+Z entry.
  return proposeAndAccept(
    state,
    result.ops,
    intent,
    [`user:${mutatorName}`],
    result.closure.spec,
    result.warnings,
  );
}

/** Shared propose → acceptSelectedOps tail. One atomic undo entry. */
function proposeAndAccept(
  baseState: DagState,
  ops: Op[],
  intent: string,
  opSources: string[],
  closureSpec: ClosureSpec,
  warnings: string[],
): DispatchResult {
  try {
    useDiffStore
      .getState()
      .propose(baseState, ops, intent, opSources, closureSpec, warnings);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const dag = useDagStore.getState();
  acceptSelectedOps(dag.dispatchAtomic.bind(dag));
  return { ok: true };
}
