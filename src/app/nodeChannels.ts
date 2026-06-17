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
// v0.7 #199: the AnimationLayer wrapper is retired — EVERY channel is now
// free-floating (it carries its own `target` + `paramPath`), so the enumeration
// is a flat scan by `params.target`. (The pre-#199 coexistence guard that
// excluded layer-wired channels is gone with the wrapper — V57.)
//
// REF: docs/UNIFICATION-DESIGN.md §3.1/§3.3; activeCamera.ts (camera precedent);
//      bakedGltfChannels.ts (glTF precedent); vyapti V20/V24/V57; hetvabhasa H40/H48.

import { getNodeType } from '../core/dag/registry';
import type { KeyframeChannelValue } from '../nodes/types';

/** Minimal node shape this enumerator reads (a DagState node subset). */
interface NodeLike {
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/**
 * The NODE refs of every free-floating direct channel targeting `targetId`.
 * Returned as stable node references so a subscribed selector can compare them
 * with `shallow` — an unrelated edit leaves each ref untouched (immutable Ops),
 * so the subscriber does not re-render (H48). Build the channel VALUES from these
 * via {@link channelValuesFromNodes} in a memo keyed off this array.
 */
export function directChannelNodesForTarget<T extends NodeLike & { id: string }>(
  nodes: Readonly<Record<string, T>>,
  targetId: string,
): T[] {
  if (!targetId) return [];
  const out: T[] = [];
  for (const node of Object.values(nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) continue;
    const p = node.params as { target?: unknown; keyframes?: unknown };
    if (p.target !== targetId) continue;
    if (!Array.isArray(p.keyframes) || p.keyframes.length === 0) continue; // empty → no overlay
    out.push(node);
  }
  return out;
}

/**
 * The set of node ids that have at least one free-floating direct channel.
 * Built in ONE pass over the nodes — the renderer computes it once per render
 * and tests membership per child, so the child map stays O(N), never O(N²)
 * (the B13 trap of scanning all nodes per child).
 */
export function directChannelTargetSet(
  nodes: Readonly<Record<string, NodeLike & { id: string }>>,
): Set<string> {
  const targets = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) continue;
    const p = node.params as { target?: unknown; keyframes?: unknown };
    if (typeof p.target !== 'string' || !p.target) continue;
    if (!Array.isArray(p.keyframes) || p.keyframes.length === 0) continue;
    targets.add(p.target);
  }
  return targets;
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
