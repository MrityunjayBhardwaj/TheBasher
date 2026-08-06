// effectiveParams — the params a node's COOK should see, with overlays already folded in
// (#524).
//
// ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────────────────
//
// The evaluator is pure over `node.params`. Overlays — keyframe channels, NLA strips,
// drivers, held transient edits — are folded at the READ and RENDER seams
// (`resolveEvaluatedParam`, `useLayeredChannels` → `overlayChannels`), onto the evaluated
// VALUE. That is right for anything the renderer applies on the way out: a material colour,
// a transform. It cannot work for a value the cook consumed to BUILD something, because the
// geometry was already computed from the raw param before any overlay existed.
//
// The failure is silent and it is not exotic. MEASURED on `main` before this module:
//
//   a Vec3 channel on a cube's `size`, 1 → 5
//     the inspector reads [5,5,5]                       ✓
//     `overlayChannels` materialises `value.data.size = [5,5,5]`   ← a field NOTHING reads
//     the geometry key stays `box|1,1,1`                ✗ the cube never moves
//
//   a driver on an `ArrayModifier`'s `count`, 2 → 9
//     `resolveEvaluatedParam` reports 9                 ✓
//     the cooked geometry stays `array|box|1,1,1|2|2,0,0`          ✗
//
// Nothing throws, nothing logs, and undo records a perfectly good entry. Every existing gate
// reads the RESOLVER, which is exactly the side that already agrees.
//
// ── WHY THE FOLD IS HERE AND NOT IN THE EVALUATOR ──────────────────────────────────────
//
// `core/dag/evaluator.ts` is UNCHANGED by this, deliberately. Two reasons, both measured
// rather than aesthetic:
//
//   1. Folding a driver means EVALUATING its source chain. Doing that from inside `evalNode`
//      is a nested walk with its own `onStack`, so a driver whose chain reaches back to the
//      node being evaluated would recurse instead of being caught as a cycle. Folding
//      BEFORE evaluation, against the un-folded state, has no such shape — it is the same
//      thing the read seam already does, and a driver reads its source, never its sink.
//   2. The fold needs the channel/strip/driver enumerators, which live here in `app/`. A
//      hook injected into core would have to thread an eval function through all of them,
//      which is how a second spelling of the fold gets written.
//
// Purity is not weakened. The effective params are a function of `state` and `ctx` — both
// already arguments to `evaluate` — so `evaluate(effectiveDagState(state, ctx), id, ctx)`
// is as deterministic as `evaluate(state, id, ctx)` ever was. Only the module layering
// forced the split.
//
// ⚠️ THE COST OF THAT CHOICE, stated here rather than discovered: this does NOT reach the
// 71 `evaluate` call sites automatically. A seam that wants the animated cook has to ask for
// it, and one that forgets keeps the stale one — silently, which is the very failure mode
// #524 is about. `effectiveParams.gate.test.ts` therefore censuses the seams that apply it,
// EXACTLY and with a reason each, so a new render road that forgets is a red rather than a
// bug report.
//
// ── WHY ONLY `cookParams`, AND WHY THAT IS THE SAFETY ARGUMENT ─────────────────────────
//
// Only params a node DECLARES as cook-consumed are folded. This is not a scope limit, it is
// what makes the change safe: a cook param is by definition absent from the evaluated value,
// so the render seam's overlay for it lands on a field with no reader either way and cannot
// combine with this one. Fold a param that DOES survive onto the value — `material`, say —
// and an additive channel would be applied twice, once here and once at the render seam.
// The declaration is gated against a real evaluation in both directions, so it cannot drift
// into that state quietly.
//
// REF: src/core/dag/types.ts (`NodeDefinition.cookParams` — the declaration and its rules);
//      src/app/resolveEvaluatedParam.ts (the fold this reuses rather than re-spells);
//      src/app/objectDataBand.ts (where the render seam writes, and why it misses these);
//      src/app/effectiveParams.gate.test.ts (the totality gate + the seam census);
//      issues #524, #492.

import { getNodeType } from '../core/dag/registry';
import { hashValue } from '../core/dag/hash';
import type { DagState } from '../core/dag/state';
import type { EvaluatorCache } from '../core/dag/evaluator';
import type { EvalCtx, Node } from '../core/dag/types';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { useTransientEditStore } from './stores/transientEditStore';

/**
 * Every node id something could be overlaying — the cheap pre-filter.
 *
 * `resolveEvaluatedParam` scans the whole node table per call, so asking it about every cook
 * param of every node would be O(nodes × params) on a road that runs per frame. Overlay
 * nodes all name their subject in a `target` param, so ONE pass collects the candidates and
 * the expensive question is then asked only of nodes that could possibly have an answer.
 *
 * Deliberately over-inclusive: a constraint also carries a `target`, and being wrong in that
 * direction costs one resolve that returns null. Being wrong the other way would silently
 * skip a real overlay, which is the bug this file exists to fix.
 */
function overlaidTargets(state: DagState): Set<string> {
  const out = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    const target = (node.params as { target?: unknown } | undefined)?.target;
    if (typeof target === 'string') out.add(target);
  }
  // Held edits live in a store, not in the graph — a node can be overlaid without any node
  // naming it. Missing this is what would make a grabbed size fail to repaint.
  for (const edit of useTransientEditStore.getState().edits.values()) out.add(edit.nodeId);
  return out;
}

/**
 * `state`, with every declared cook param replaced by its overlaid value at `ctx.time`.
 *
 * Returns the SAME state object when nothing is overlaid, and keeps every untouched node's
 * object identity when something is. Both matter: the evaluator memoises its params hash on
 * the params object identity (a `WeakMap`), so a fresh object for an unchanged node would
 * turn a per-frame O(changed) walk into O(scene).
 */
export function effectiveDagState(state: DagState, ctx: EvalCtx, cache?: EvaluatorCache): DagState {
  const candidates = overlaidTargets(state);
  if (candidates.size === 0) return state;

  let changedAny = false;
  const nodes: Record<string, Node> = {};

  for (const [id, node] of Object.entries(state.nodes)) {
    nodes[id] = node;
    if (!candidates.has(id)) continue;
    const cookParams = getNodeType(node.type)?.cookParams;
    if (!cookParams || cookParams.length === 0) continue;

    let params: Record<string, unknown> | null = null;
    for (const param of cookParams) {
      const resolved = resolveEvaluatedParam(state, id, param, ctx, cache);
      if (resolved === null) continue;
      const base = (node.params as Record<string, unknown> | undefined)?.[param];
      // Hashed rather than `Object.is`: every cook param that matters is a tuple or an
      // object, and reference equality would report every frame as a change — which is
      // correct but costs the whole memo, so it would be a silent performance defect
      // rather than a silent behavioural one.
      if (hashValue(resolved.value) === hashValue(base)) continue;
      params ??= { ...(node.params as Record<string, unknown>) };
      params[param] = resolved.value;
    }

    if (params !== null) {
      nodes[id] = { ...node, params };
      changedAny = true;
    }
  }

  return changedAny ? { ...state, nodes } : state;
}
