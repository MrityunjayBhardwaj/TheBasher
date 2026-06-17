// resolveEvaluatedParam — the GENERIC evaluated-param resolver for NON-transform
// inspector fields (issue #149, Wave C2). Transform fields keep
// resolveTransformParam → resolveEvaluatedTransform (which carries the
// direct-channel overlay + scene-index correspondence + glTF-child branch). This
// is the NON-transform sibling — there is NO mega-resolver (RESEARCH reshaping
// #3).
//
// Precedence (the SAME transient > channel rule the renderer + transform read
// use): transient → channel.sample() → base(null).
//
// THE H40 form-1 TRAP this is built to avoid: re-implementing keyframe
// interpolation here would DRIFT from the renderer (the renderer samples the
// channel VALUE's `.sample(seconds)`, which carries the easing + colour-blend +
// quaternion-interpolation logic per channel type). So this resolver MUST
// evaluate the channel NODE and call its `.sample()` — the
// render-identical path. It NEVER does raw keyframe-array interpolation. A grep
// gate in the test bans interpolation math in this file (mirrors resolveTransformParam's
// "no isolated evaluate" gate). Gated end-to-end by the C4 non-transform PAUSED
// boundary-pair e2e.
//
// REF: issue #149, PLAN.md Wave C (C2); hetvabhasa H40; paramAnimationState.ts:71-77
//      (the SAME channel scan); KeyframeChannel*Value.sample (types.ts:719-737).

import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type { KeyframeChannelValue } from '../nodes/types';
import { useTransientEditStore } from './stores/transientEditStore';

interface ChannelParams {
  target?: unknown;
  paramPath?: unknown;
}

/**
 * Resolve the evaluated value of a NON-transform param for `nodeId`.
 *
 * Precedence:
 *   1. transient — a held edit (transientEditStore) wins.
 *   2. channel — the KeyframeChannel* whose (target, paramPath) match, evaluated
 *      and sampled at ctx.time.seconds via its VALUE's `.sample()` (the
 *      render-identical path — CANNOT drift from the renderer).
 *   3. base — null (caller falls back to node.params[paramPath], the same
 *      null-contract as resolveTransformParam).
 *
 * Returns `{ value }` for layers 1-2, or null for layer 3.
 */
export function resolveEvaluatedParam(
  state: DagState,
  nodeId: string,
  paramPath: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): { value: unknown } | null {
  // 1. Transient wins (the held edit — same precedence as render + transform read).
  const transient = useTransientEditStore.getState().get(nodeId, paramPath);
  if (transient) return { value: transient.value };

  // 2. Channel — find the KeyframeChannel* node (SAME scan as
  //    paramAnimationState.ts:71-77), then EVALUATE the node and call .sample().
  //    This is the render-identical path — it samples the channel VALUE, not raw
  //    keyframes, so it cannot drift from the renderer (H40 form 1).
  for (const node of Object.values(state.nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) continue;
    const p = (node.params ?? {}) as ChannelParams;
    if (p.target !== nodeId || p.paramPath !== paramPath) continue;
    try {
      const channelValue = evaluate(state, node.id, { cache, ctx }).value as KeyframeChannelValue;
      return { value: channelValue.sample(ctx.time.seconds) };
    } catch {
      return null; // unevaluable channel → fall back to base
    }
  }

  // 3. No channel → base (caller reads node.params[paramPath]).
  return null;
}
