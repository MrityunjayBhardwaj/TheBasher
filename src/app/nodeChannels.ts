// nodeChannels — enumerate the free-floating "direct" KeyframeChannels driving a
// node (v0.7 unification, #197). The native-mesh analogue of the camera's inline
// channel scan (`resolveActiveCameraPoseAt`, activeCamera.ts:136) and the glTF
// baked enumeration (`bakedChannelSamplersForAsset`) — generalized to ANY target
// + ANY paramPath, so one primitive feeds the renderer + read-side overlay that
// `overlayChannels` then applies (the camera/glTF "direct channel" road).
//
// Each channel value is built via the channel node's OWN `evaluate` (through the
// registry), so the sampling math is the SAME source the dopesheet/camera/glTF
// paths use — no parallel sampler, no drift (H40 / V24). Values are
// function-of-time: build once per DAG change, sample per frame at the caller's
// cadence (renderer useFrame snapshot / read-side ctx.time — never a time
// subscription, H48).
//
// COEXISTENCE GUARD (removable at Phase 5, #199): a channel wired into an
// `AnimationLayer.animation` socket ALSO carries `params.target === <wrapped
// node>` (addChannel sets it). Until the wrapper is retired, the layer path
// (`AnimationLayerR`) already overlays those channels — so the DIRECT enumeration
// MUST exclude them or the node double-overlays. We collect every channel id
// referenced by any layer's `animation` input and skip it. Once no layers exist
// (Phase 5 migration), the excluded set is empty and this is a no-op.
//
// REF: docs/UNIFICATION-DESIGN.md §3.1/§3.3; activeCamera.ts (camera precedent);
//      bakedGltfChannels.ts (glTF precedent); vyapti V20/V24; hetvabhasa H40/H48.

import { getNodeType } from '../core/dag/registry';
import type { KeyframeChannelValue } from '../nodes/types';

/** Minimal node shape this enumerator reads (a DagState node subset). */
interface NodeLike {
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** Collect every channel node id referenced by any AnimationLayer's `animation`
 *  input — these are owned by the layer path and must NOT be overlaid directly
 *  (the coexistence guard). Returns an empty set once no layers exist. */
function layerWiredChannelIds(nodes: Readonly<Record<string, NodeLike>>): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type !== 'AnimationLayer') continue;
    const anim = node.inputs?.animation;
    const refs = Array.isArray(anim) ? anim : anim ? [anim] : [];
    for (const ref of refs) {
      const id = (ref as { node?: string } | undefined)?.node;
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * The NODE refs of every free-floating direct channel targeting `targetId`
 * (excluding layer-wired channels). Returned as stable node references so a
 * subscribed selector can compare them with `shallow` — an unrelated edit leaves
 * each ref untouched (immutable Ops), so the subscriber does not re-render (H48).
 * Build the channel VALUES from these via {@link channelValuesFromNodes} in a memo
 * keyed off this array.
 */
export function directChannelNodesForTarget<T extends NodeLike & { id: string }>(
  nodes: Readonly<Record<string, T>>,
  targetId: string,
): T[] {
  if (!targetId) return [];
  const wired = layerWiredChannelIds(nodes);
  const out: T[] = [];
  for (const node of Object.values(nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) continue;
    if (wired.has(node.id)) continue; // owned by the layer path (coexistence guard)
    const p = node.params as { target?: unknown; keyframes?: unknown };
    if (p.target !== targetId) continue;
    if (!Array.isArray(p.keyframes) || p.keyframes.length === 0) continue; // empty → no overlay
    out.push(node);
  }
  return out;
}

/** Build the function-of-time {@link KeyframeChannelValue} for each channel node,
 *  via the node's OWN `evaluate` (one sampling source, no drift). Unknown/dead
 *  node types are skipped. */
export function channelValuesFromNodes(nodes: readonly NodeLike[]): KeyframeChannelValue[] {
  const out: KeyframeChannelValue[] = [];
  for (const node of nodes) {
    const def = getNodeType(node.type);
    if (!def) continue;
    // A KeyframeChannel* evaluate is a pure function of its params (no inputs, no
    // time/ctx — V24/V3): time enters later via value.sample(seconds). Cast to the
    // params-only form so we don't fabricate an unused ResolvedInputs/EvalCtx.
    const evaluate = def.evaluate as (params: unknown) => KeyframeChannelValue;
    out.push(evaluate(node.params));
  }
  return out;
}

/**
 * Convenience: the direct-channel VALUES targeting `targetId`, built in one call.
 * For the renderer prefer the two-step form ({@link directChannelNodesForTarget} +
 * a memo of {@link channelValuesFromNodes}) so the per-frame sample closures are
 * rebuilt only when a channel node ref actually changes (H48). This one-shot form
 * is for pure read-side resolvers that run on demand (gizmo / inspector / render
 * action), never per frame.
 */
export function directChannelValuesForTarget(
  nodes: Readonly<Record<string, NodeLike & { id: string }>>,
  targetId: string,
): KeyframeChannelValue[] {
  return channelValuesFromNodes(directChannelNodesForTarget(nodes, targetId));
}
