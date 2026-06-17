// Resolve the per-PARAM evaluated transform value the NPanel inspector
// SHOULD display next to a transform-section field, or null when the field
// should keep its today's static-source behavior (no animation, no rendered
// correspondence, or the resolver returns null).
//
// WHY this exists (issue #69 — NPanel ↔ evaluated-scene boundary, the
// explicit H40 sibling of #68 scoped OUT of 7.3 D-08):
//   `NumericField`/`VectorComponent` derive `display = scrub.isDragging ?
//   scrub.previewValue : value` where `value` comes from `node.params.X`
//   (the static authored source). The moment a transform param is
//   animated, the rendered object moves (a free-floating direct channel's
//   sampled value is overlaid by `overlayChannels` — V57) but the inspector
//   freezes at the authored value. Same root cause as #68's gizmo (H40);
//   same fix vehicle: the pure resolver that mirrors the renderer's
//   scene-child correspondence + overlays the direct channel (Chesterton —
//   resolveEvaluatedTransform.ts).
//
// THE H40 NAMED TRAP, restated for this helper:
//   `evaluate(state, selectedId, ctx)` returns the box's RAW value (the
//   source node, never mutated). The animated value lives in the WRAPPER's
//   output, keyed by the channel's paramPath. This helper CONSUMES the
//   resolver — it MUST NOT call `evaluate(state, selectedId, ...)` in
//   isolation or invent a parallel walk. The grep gate at this file
//   enforces the rule (zero `evaluate(` matches in this file).
//
// V8 file-location justification: this lives in `src/app/` because its
//   caller (`NPanel.tsx`, `src/app/`) and the resolver it consumes
//   (`resolveEvaluatedTransform.ts`, `src/app/`) both sit in `src/app/`.
//   Placing it in `src/viewport/` would force `src/app/NPanel.tsx` to
//   import upward into the viewport tree — the same V8 violation
//   `resolveEvaluatedTransform.ts:24-29` already guards against for the
//   gizmo. This is inspector-display logic, not scene composition.
//
// D-01 contract (CONTEXT.md:30-40): null ⇒ caller uses the static `value`
//   prop (today's behavior, byte-identical, no crash). Per-param fallback
//   exactly mirrors the gizmo seam at Gizmo.tsx:205-229. A non-null Vec3
//   ⇒ the field displays this value (which may equal the static authored
//   value when the resolver preserved an un-channelled field through the
//   direct-channel overlay — that's correct-by-construction, not a special case).
//
// D-03 scope (CONTEXT.md:53-59): transform-only. `paramPath` is whitelisted
//   to `'position' | 'rotation' | 'scale'`. Anything else (e.g. material
//   colour, opacity) returns null immediately — non-transform animated
//   params keep their static-source behavior by construction. The whitelist
//   IS the D-03 fence, encoded in code (not just in the spec).
//
// V20 cadence: this helper is a PURE synchronous function — no React
//   hooks, no `useTimeStore`/`useDagStore` calls, no subscriptions, no
//   side effects. The caller (W2.1's NPanel callsite) governs the render
//   cadence via `useTimeStore(s => s.frame)` — the same shape Gizmo.tsx:124
//   uses. This file must never grow a store read; the test suite asserts
//   that structural property by source-grep (W2.1's grep gate).
//
// REF: issue #69, CONTEXT D-01/D-03 (.planning/phases/7.4-npanel-evaluated-display/CONTEXT.md),
//      hetvabhasa H40 (.anvi/hetvabhasa.md:994-1014), the resolver at
//      resolveEvaluatedTransform.ts:84-164, the gizmo's same-seam consumer
//      at Gizmo.tsx:142-167 / :205-229.

import { resolveEvaluatedTransform } from './resolveEvaluatedTransform';
import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';

type Vec3 = [number, number, number];

/** Transform-only paramPath whitelist (D-03). Encoded as a type union so
 *  callers get a compile-time fence; the runtime guard inside the helper
 *  is the belt-and-suspenders for callsites that pass `string`. */
export type TransformParamPath = 'position' | 'rotation' | 'scale';

const TRANSFORM_PARAMS: ReadonlySet<string> = new Set<TransformParamPath>([
  'position',
  'rotation',
  'scale',
]);

/**
 * Resolve the per-param evaluated transform value for `selectedId` at the
 * caller-supplied `ctx`. Returns the Vec3 the NPanel field SHOULD display,
 * or `null` when the field should keep its today's static-source behavior.
 *
 * Pure: no store reads, no subscriptions, no side effects. The caller
 * passes `state`, `selectedId`, `paramPath`, `ctx`, plus the optional
 * shared evaluator `cache`. The caller (W2.1) subscribes — this helper
 * does NOT.
 *
 * Null branches (D-01 caller falls back to static `value`):
 *   - `selectedId == null` (nothing selected — no animated source to read)
 *   - `paramPath` outside the transform whitelist (D-03)
 *   - resolver returns null (selectedId not a rendered scene child /
 *     wrapped target — same identity-null path as the gizmo)
 *   - resolver's per-param field is null (rotation/scale absent on the
 *     evaluated child — pass through, per-param fallback in the caller)
 */
export function resolveTransformParam(
  state: DagState,
  selectedId: string | null,
  paramPath: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 | null {
  // 1. Nothing selected → null (caller shows static `value`).
  if (selectedId == null) return null;

  // 2. D-03 scope guard: transform-only. Non-transform paramPaths return
  //    null → caller shows static `value` (today's behavior, by
  //    construction).
  if (!TRANSFORM_PARAMS.has(paramPath)) return null;

  // 3. Consume the shared resolver — the ONE place "where it actually
  //    renders" is derived (H40 mechanism). NEVER `evaluate(state,
  //    selectedId, ...)` here — that returns the RAW source value (the
  //    named trap). The resolver overlays the free-floating direct channel
  //    via the SceneFromDAG index-correspondence (V57).
  const result = resolveEvaluatedTransform(state, selectedId, ctx, cache);
  if (result == null) return null;

  // 4. Per-param projection. Each field is `Vec3 | null` (for position the
  //    resolver guarantees Vec3 when result is non-null; for rotation/scale
  //    null is possible when the evaluated child carries none — pass it
  //    through so the caller falls back to the static authored value for
  //    that one param).
  switch (paramPath as TransformParamPath) {
    case 'position':
      return result.position;
    case 'rotation':
      return result.rotation;
    case 'scale':
      return result.scale;
  }
}
