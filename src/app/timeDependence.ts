// Which nodes are time-dependent — i.e. whose cooked value is a function of `t` (#578,
// epic #575).
//
// ⚠️ READ THIS BEFORE ASSUMING WHAT IT IS FOR. The reference substrate carries a
// time-dependence flag so that static subtrees are not recooked every frame. **We already
// have that property by a different mechanism** and this function is NOT what buys it: a
// pure node's cache key is `id@type#version|p:paramsHash|i:inputsHash` with the time term
// appended only when the node is IMPURE (`core/dag/evaluator.ts`), so a node whose params
// and inputs are unchanged hits cache across a scrub with no flag involved. Measured: with
// 1 of 20 chains animated, a full scrub costs the same as a fully static one.
//
// WHAT IT IS ACTUALLY FOR. The fold that turns authored params into `params@t` must run on
// the animated nodes and NOT on everything else, because folding indiscriminately destroys
// two caches — measured on this tree:
//   • the params-hash memo is keyed on params OBJECT IDENTITY, so a fresh object every
//     frame misses it: 0.001 → 4.77 ms/frame on a heavy-params node (3644×);
//   • a changed param changes the geometry key, so every frame becomes a registry miss and
//     a real build: 0.242 ms/frame per animated object (2251×).
// Everything this function does NOT return keeps its authored params object, its memo entry
// and its cache key. That is the whole value.

import type { DagState } from '../core/dag/state';
import { edges } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';

/** A channel needs TWO keyframes to vary; one key is a constant and must not be folded
 *  per frame. Kept as a named constant because it is a decision, not an implementation
 *  detail — see the gate case that pins it. */
const MIN_KEYFRAMES_TO_VARY = 2;

interface Counters {
  /** How many nodes the downstream walk visited. Each node must be visited once. */
  visits: number;
}

/**
 * Every node whose cooked value depends on `t`, as a set of ids.
 *
 * Seeds:
 *   1. `TimeSource` — the declared and only time source.
 *   2. Any node carrying an overlay that genuinely varies over `t`: a keyframe channel
 *      with ≥2 keyframes, or a Strip.
 *
 * Deliberately NOT seeds:
 *   • A channel with a single keyframe — constant over `t`; fold it once, never per frame.
 *   • A `ParamDriver` — constant over `t` today, because the compute vocabulary it reads
 *     has no time-varying leaf. Pinned by a gate case, so that if a driver ever gains a
 *     time-varying source this decision is revisited loudly instead of being silently
 *     wrong.
 *
 * Note the channel NODE itself is not flagged by being a channel: its `evaluate` returns a
 * sampler whose value does not change per frame — the `t`-dependence lands on its TARGET,
 * which is what gets folded.
 *
 * ⚠️ THIS IS A SOUND OVER-APPROXIMATION, AND THE DIRECTION MATTERS TO ITS CONSUMER. The
 * walk below is REACHABILITY, not a per-node transfer function: a node is flagged because
 * something time-varying reaches it, even if that node discards the value it received. So
 * the returned set can be larger than the truth and is never smaller.
 *
 * That is the safe side, because the asymmetry at the consumer is severe. `foldOverlays`
 * treats a node outside this set as never needing to re-resolve, at any playhead. Naming a
 * node that does not really vary costs a re-resolve that computes the same value; FAILING
 * to name one that does freezes it at whatever frame it was first folded at, with no test
 * at any tier able to see the difference. Tighten this only in the direction that keeps
 * that property — and if a per-node transfer function is ever added, the gate to write
 * first is the one that catches under-naming.
 */
export function timeDependentNodes(state: DagState, counters?: Counters): Set<NodeId> {
  const seeds = new Set<NodeId>();

  for (const node of Object.values(state.nodes)) {
    if (node.type === 'TimeSource') {
      seeds.add(node.id);
      continue;
    }

    const p = node.params as { target?: unknown; keyframes?: unknown; action?: unknown };

    // A Strip is time-varying by construction: it places an action on the timeline.
    if (node.type === 'Strip') {
      if (typeof p.target === 'string' && p.target && p.action) seeds.add(p.target);
      continue;
    }

    // A keyframe channel varies only with two or more keys. `ParamDriver` also carries a
    // `target` but no `keyframes`, so it falls out here without a type test — which is
    // the behaviour the driver gate case pins.
    if (typeof p.target === 'string' && p.target && Array.isArray(p.keyframes)) {
      if (p.keyframes.length >= MIN_KEYFRAMES_TO_VARY) seeds.add(p.target);
    }
  }

  // Consumers by producer, so the walk goes DOWNSTREAM (an edge is stored on the consumer,
  // pointing up).
  const consumersOf = new Map<NodeId, NodeId[]>();
  for (const e of edges(state)) {
    const list = consumersOf.get(e.producer.node);
    if (list) list.push(e.consumer);
    else consumersOf.set(e.producer.node, [e.consumer]);
  }

  // Breadth-first from the seeds. `out` doubles as the visited set, so a node reachable by
  // several paths is expanded once — the property the call-count case asserts.
  const out = new Set<NodeId>();
  const queue: NodeId[] = [];
  for (const s of seeds) {
    // A seed naming a node that no longer exists (a stale overlay target) is skipped
    // rather than propagated — it has no consumers to reach anyway.
    if (state.nodes[s] && !out.has(s)) {
      out.add(s);
      queue.push(s);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    if (counters) counters.visits++;
    for (const consumer of consumersOf.get(id) ?? []) {
      if (out.has(consumer)) continue;
      out.add(consumer);
      queue.push(consumer);
    }
  }

  return out;
}
