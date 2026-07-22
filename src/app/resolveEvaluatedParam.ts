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
import { foldChannelValue, type ChannelContribution } from '../nodes/foldChannel';
import { stripChannelValuesForTarget } from './layeredChannels';
import { driverChannelValuesForTarget } from './paramDrivers';
import { readBaseParam } from './readBaseParam';
import { resolveDataParamOwner } from './resolveDataParamOwner';
import { useTransientEditStore } from './stores/transientEditStore';
import { isKeyframeChannelNode } from './animate/paramAnimationState';

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
  requestedNodeId: string,
  paramPath: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): { value: unknown } | null {
  const nodeId = requestedNodeId;

  // 1. Transient wins (the held edit — same precedence as render + transform read).
  const transient = useTransientEditStore.getState().get(nodeId, paramPath);
  if (transient) return { value: transient.value };

  // 2. Channels — collect EVERY KeyframeChannel* whose (target, paramPath) match
  //    (SAME scan as paramAnimationState.ts:71-77), each EVALUATED and sampled via
  //    its VALUE's `.sample()` — the render-identical path (H40 form 1: never raw
  //    keyframe math). Collecting ALL of them (not first-match) is what lets the
  //    compositor read match the render for stacked channels (#283 Phase 1).
  // Per-channel SOLO (#263), the read twin of the render-side filter in
  // `channelValuesFromNodes`. Scope is per-TARGET (any solo channel on `nodeId`, on
  // ANY param), computed identically to the render side so render == read: when the
  // target has a solo'd channel, only solo'd channels contribute to THIS param too
  // (so resolving a non-solo sibling param falls back to base). Byte-identical when
  // nothing is solo'd. Strips/drivers (2b/2c) are appended after — un-gated, matching
  // the render side (they aren't collected through `channelValuesFromNodes` either).
  const targetSoloActive = Object.values(state.nodes).some((node) => {
    if (!isKeyframeChannelNode(node)) return false;
    return (
      (node.params as ChannelParams & { solo?: boolean })?.solo === true &&
      (node.params as ChannelParams)?.target === nodeId
    );
  });

  const matches: KeyframeChannelValue[] = [];
  for (const node of Object.values(state.nodes)) {
    if (!isKeyframeChannelNode(node)) continue;
    const p = (node.params ?? {}) as ChannelParams & { solo?: boolean };
    if (p.target !== nodeId || p.paramPath !== paramPath) continue;
    if (targetSoloActive && p.solo !== true) continue; // soloed out → contributes nothing
    try {
      matches.push(evaluate(state, node.id, { cache, ctx }).value as KeyframeChannelValue);
    } catch {
      // unevaluable channel → skip it (a lone bad channel ⇒ base fallback below).
    }
  }

  // 2b. NLA strips (#283 Phase 2, E) — append the strip-derived synthetic channels
  //     for THIS param so a placed Strip reads == renders (H40). The SAME enumerator
  //     the render seam uses; param-scoped here. No strips → `matches` unchanged →
  //     byte-identical. The fold below treats bare channels + strips uniformly.
  for (const v of stripChannelValuesForTarget(state.nodes, nodeId)) {
    if (v.paramPath === paramPath) matches.push(v);
  }

  // 2c. Drivers (#293, Inc 2 — the PULL rail). Every ParamDriver bound to
  //     (nodeId, paramPath), EVALUATED so its `in` input resolves through the
  //     compute graph. A driver's evaluate returns a KeyframeChannelValue, so it
  //     folds through the SAME `overlayChannels`/`foldChannelValue` as channels +
  //     strips (H40 — the pull twin of the push overlay). No driver → `matches`
  //     unchanged → byte-identical. This is the READ side; the render side
  //     (SceneFromDAG useLayeredChannels) consumes the SAME enumerator.
  for (const v of driverChannelValuesForTarget(state, nodeId, ctx, cache)) {
    if (v.paramPath === paramPath) matches.push(v);
  }

  // 3. No channel/driver on the requested node → before giving up, reach through the
  //    object↔data split (#398). A cube's `material`/`size` live on its linked data node,
  //    and the inspector renders those rows against THAT node, so a keyed material channel
  //    targets the data half while a caller naturally names the cube (the Object). Without
  //    this reach the render overlays the animated value and every read surface reports the
  //    static base — the two roads disagree (H40).
  //
  //    Deliberately a FALLBACK rather than an up-front redirect: a channel authored against
  //    the Object with a data paramPath must keep resolving too (both conventions exist, and
  //    up-front redirection silently breaks the first). Everything above is untouched, so a
  //    node that resolves on its own — every fused node — is byte-identical.
  if (matches.length === 0) {
    const paramRoot = paramPath.split('.')[0] ?? paramPath;
    const ownerId = resolveDataParamOwner(state, requestedNodeId, paramRoot);
    if (ownerId !== null && ownerId !== requestedNodeId) {
      // Recurse first so the data node's OWN channels/transients win (the #398 overlay).
      const viaOwner = resolveEvaluatedParam(state, ownerId, paramPath, ctx, cache);
      if (viaOwner !== null) return viaOwner;
      // #399 — the BASE-read twin of #398. When the data node has no overlay either,
      // reach through the split for its base VALUE instead of returning null: a caller
      // naming the Object (`n_box`) would otherwise fall back to `n_box.params.material`,
      // which the Object doesn't own, and surface the fallback grey. Read the base off
      // the true owner (the BoxData) so the base colour/size is the cube's real one.
      const base = readBaseParam(state.nodes[ownerId], paramPath);
      return base === undefined ? null : { value: base };
    }
    return null;
  }

  // Single channel — the pre-#283 first-match contract, byte-identical.
  // #283 Phase 3: a crossfading match (carries `influenceAt`) MUST fall through to
  // the fold below so read matches render (which always folds toward base at inf<1).
  // No existing value carries `influenceAt` → every current single-match read keeps
  // this fast path (byte-identical).
  if (matches.length === 1 && !matches[0].influenceAt)
    return { value: matches[0].sample(ctx.time.seconds) };

  // 2+ channels on ONE param → compose with the SAME ordered, weighted fold the
  // renderer uses (overlayChannels → foldChannelValue), so the compositor read
  // matches the render for stacked params (V88 D3 / H40). Base = the node's own
  // param value at this path; sort bottom→top by `order`; influence = per-channel
  // weight (the caller weight is 1 for reads).
  const sorted = matches.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // Base resolves params-first-then-spare (#293 Q1: a real param wins; a spare
  // cannot shadow it) so a Combine overlay onto a spare-param target folds onto its
  // spare value, not `undefined`. Replace overlays ignore base (byte-identical).
  const base = readBaseParam(state.nodes[nodeId], paramPath);
  const contribs: ChannelContribution[] = sorted.map((ch) => ({
    value: ch.sample(ctx.time.seconds),
    mode: ch.blendMode ?? 'replace',
    // #283 Phase 3 — time-varying influence (lockstep with overlayChannels.ts).
    influence: ch.influenceAt ? ch.influenceAt(ctx.time.seconds) : (ch.weight ?? 1),
  }));
  return { value: foldChannelValue(base, contribs, sorted[0].valueType, paramPath) };
}
