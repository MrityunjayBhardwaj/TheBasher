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
 * The NODE refs of every free-floating KeyframeChannel whose `params.target` is
 * in `ids` — the id-reference universe that lives OUTSIDE the edge graph ([[H136]]).
 * Unlike {@link directChannelNodesForTarget} this does NOT filter empty channels:
 * a subtree op (delete/duplicate) must account for an empty-keyframe channel too
 * (it is still orphan bloat on delete, still lost on duplicate). The "referencers
 * of these nodes" primitive that whole-object ops mirror alongside the edge walk.
 */
export function channelNodesTargeting<T extends NodeLike & { id: string }>(
  nodes: Readonly<Record<string, T>>,
  ids: ReadonlySet<string>,
): T[] {
  if (ids.size === 0) return [];
  const out: T[] = [];
  for (const node of Object.values(nodes)) {
    if (!node.type.startsWith('KeyframeChannel')) continue;
    const p = node.params as { target?: unknown };
    if (typeof p.target === 'string' && ids.has(p.target)) out.push(node);
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

/**
 * The set of node ids that have an ANIMATED ANCESTOR — an ancestor (walking UP the
 * scene hierarchy via the `children`/`target` input sockets) that is itself in
 * `animatedSet`. Used so a separately-rendered editor visual (the camera frustum,
 * #242 / [[H132]] GAP 1) nested under an animated Group mounts a per-frame follower
 * EVEN WHEN the node itself is un-keyed: its world pose changes per frame as the
 * ancestor moves, so the static frame-0 read would freeze (the render-source split).
 *
 * Meshes don't need this — an animated top-level Group renders through DirectChannelsR
 * → MeshChild → GroupR, which re-renders the whole subtree at the patched transform,
 * so nested meshes follow for free. The frustum is a SEPARATE top-level visual, so it
 * needs the gate widened explicitly (`resolveCameraPoseAt` already composes the
 * ancestor world at live `seconds` via `resolveParentWorldMatrix`).
 *
 * `animatedSet` should be `directChannelTargetSet` — the channel-animated ancestors
 * `resolveParentWorldMatrix` actually follows per-frame (it overlays the top-level
 * child's channels at `ctx.seconds`). A constraint-rotation-only ancestor is NOT
 * followed by that resolver, so it is intentionally excluded (a documented narrow
 * limitation — a position-keyed Track-To'd ancestor is still caught via its channels).
 *
 * The hierarchy socket set (`children` for Group/Scene, `target` for
 * Transform/MaterialOverride) MUST mirror `childEdges` / `resolveParentWorldMatrix`'s
 * walk in resolveWorldTransform.ts — the source of truth for what counts as a
 * scene-graph parent. Built in ~O(N) (one parent-map pass + a bounded walk up per
 * node, cycle-guarded) and tested by membership, so the renderer stays O(N) (B13).
 */
export function animatedAncestorSet(
  nodes: Readonly<Record<string, NodeLike & { id: string }>>,
  animatedSet: ReadonlySet<string>,
): Set<string> {
  // child id -> its parent ids (multi-valued for safety, though scene hierarchy is a
  // tree in practice). Only the `children`/`target` sockets count as parent edges.
  const parents = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    for (const socket of ['children', 'target'] as const) {
      const b = node.inputs?.[socket];
      const refs = Array.isArray(b) ? b : b ? [b] : [];
      for (const r of refs) {
        const childId = (r as { node?: string } | undefined)?.node;
        if (typeof childId !== 'string' || !childId) continue;
        const list = parents.get(childId);
        if (list) list.push(node.id);
        else parents.set(childId, [node.id]);
      }
    }
  }
  const out = new Set<string>();
  for (const id of Object.keys(nodes)) {
    // BFS up the ancestor chain; mark `id` if any ancestor is animated. The `seen`
    // guard makes a malformed cyclic graph terminate instead of looping forever.
    const seen = new Set<string>([id]);
    const stack = [...(parents.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (animatedSet.has(cur)) {
        out.add(id);
        break;
      }
      stack.push(...(parents.get(cur) ?? []));
    }
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
