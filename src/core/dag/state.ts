// Plain-object DAG state. The zustand store wraps this; the Op dispatcher
// reads/writes through pure functions so we can unit-test without React.
//
// Discipline: this module exports NO mutating functions. State changes flow
// through `applyOp` in ops.ts, never via direct field writes. (V1.)
//
// REF: THESIS.md §50.

import type { Node, NodeId, NodeRef } from './types';

/**
 * The graph WITHOUT any claim about what its params mean — ids, types, edges, outputs.
 *
 * This is the type for a reader that cannot care whether params are authored or evaluated
 * at a time: a node listing, an ownership resolution, a cycle check. Both `DagState` and
 * `CookState` are assignable to it, and it is assignable to neither, so taking it is a
 * statement that no param VALUE is read — not a way to accept either and hope.
 *
 * Who is allowed to take it is not a matter of taste: `src/app/paramsAt.gate.test.ts` names
 * every evaluator consumer and its reason, and pins that list exactly.
 */
export interface DagGraph {
  /** All nodes keyed by id. */
  nodes: Record<NodeId, Node>;
  /** Named output sockets exposed by the project (e.g. 'scene', 'render'). */
  outputs: Record<string, NodeRef>;
}

/**
 * The graph with params exactly as the director authored them. The store holds this, ops
 * read and write it, undo restores it, and an inspector showing a typed value reads it.
 *
 * ── WHY THIS IS A DISTINCT TYPE FROM `CookState`, AND WHY THE TYPE IS THE ONLY TIER ────
 *
 * A consumer that should have received params AT TIME t, and received authored params
 * instead, computes THE SAME VALUE in every static scene. The two programs differ only
 * part-way through an animation, at a value nobody wrote down. No unit assertion, no
 * snapshot and no browser case reliably tells them apart — which is the condition under
 * which a signature is the only place the constraint can live.
 *
 * The other direction is not documentation either, it is arithmetic. Overlay seams read
 * the base value they are folding onto: `combine` blends against it, and `replace` lerps
 * from it whenever influence < 1 (a weighted channel, a crossfading strip). So handing
 * already-folded params to a seam that folds again is WRONG, not merely redundant. The
 * one exception is a transient, which is a plain write and therefore idempotent — that
 * exception is what lets the static tier of the fold reach the renderer safely, and it is
 * stated at the fold rather than assumed here.
 *
 * `paramsAt` is a phantom: nothing ever writes it, it is optional so every existing value
 * satisfies it, and it never reaches serialization. Its only job is to stop the two states
 * being interchangeable.
 */
export interface DagState extends DagGraph {
  readonly paramsAt?: 'authored';
}

/**
 * The graph with every overlay folded into params — the value at *t*.
 *
 * Minted ONLY by `foldOverlays` (`src/app/cookState.ts`). A consumer that takes this must
 * not fold again; see the arithmetic in `DagState` above for why that is a correctness
 * rule and not a style one.
 */
export interface CookState extends DagGraph {
  readonly paramsAt: 'cooked';
}

/**
 * Either state — the signature for `evaluate` alone.
 *
 * ⚠️ THIS IS NOT A THIRD OPTION FOR CONSUMERS, AND WIDENING ANYTHING ELSE TO IT DEFEATS THE
 * WALL. `evaluate` is pure over whatever params it is handed: it computes the value those
 * params describe and has no way to know which the caller SHOULD have brought. That is the
 * whole reason the census exists — the constraint lives at each consumer's own signature,
 * where somebody has to decide, and there is nobody to decide at the bottom.
 *
 * Taking this type is therefore a statement that the decision was made ELSEWHERE, and the
 * only function entitled to make it is the one every consumer already routes through.
 * `src/app/paramsAt.gate.test.ts` pins the set of users so a second one cannot appear by
 * quietly reaching for the convenient type.
 */
export type EvaluableState = DagState | CookState;

export function emptyDagState(): DagState {
  return { nodes: {}, outputs: {} };
}

/**
 * A copy of the graph that OWNS its records — no field of the result is reachable
 * from the store the original came from.
 *
 * ── WHY THIS EXISTS (#620) ─────────────────────────────────────────────────────
 *
 * Every builder that packages the DAG for something outside the store used to
 * compose its envelope as `{ nodes: state.nodes, outputs: state.outputs }` — the
 * store's OWN records under a new roof. The envelope reads as a self-contained
 * snapshot and is not one: a caller that adjusts it before writing (strip a node,
 * redact an asset) silently edits the open scene instead.
 *
 * This is latent rather than live ONLY because `applyOp` is copy-on-write — it
 * replaces the node table and the touched node rather than writing through them
 * (`ops.ts`), so an outside holder sees a correctly frozen table by accident of that
 * discipline, not by construction. The moment anything mutates a record in place,
 * every aliasing envelope moves with it. Detaching at the door removes the
 * dependence on a discipline the recipient cannot see and never agreed to.
 *
 * The clone is `structuredClone`, and it is behaviour-preserving at these seams
 * because each envelope is serialised to JSON immediately afterwards — the copy
 * costs nothing the export was not already paying, and its JSON is byte-identical
 * to the alias's.
 *
 * It clones the graph WHOLESALE rather than field by field, deliberately. A
 * version that spread the input and replaced `nodes` and `outputs` by name would
 * be the same bug one level up: any field added to `DagState` later would pass
 * through the spread as a live reference, and the guarantee this function exists
 * to make would quietly become partial. Cloning the whole value keeps the claim
 * total — every graph type here is serialisable by construction, because it is
 * the on-disk save format.
 */
export function detachGraph<G extends DagGraph>(graph: G): G {
  return structuredClone(graph);
}

export function getNode(state: DagState, id: NodeId): Node {
  const n = state.nodes[id];
  if (!n) throw new Error(`Node not found: ${id}`);
  return n;
}

export function hasNode(state: DagState, id: NodeId): boolean {
  return Object.prototype.hasOwnProperty.call(state.nodes, id);
}

/** Iterate every (consumerId, socket, producer) edge currently in the graph. */
export function* edges(
  state: DagState,
): Generator<{ consumer: NodeId; socket: string; producer: NodeRef }> {
  for (const consumer of Object.values(state.nodes)) {
    for (const [socket, binding] of Object.entries(consumer.inputs)) {
      if (Array.isArray(binding)) {
        for (const ref of binding) yield { consumer: consumer.id, socket, producer: ref };
      } else {
        yield { consumer: consumer.id, socket, producer: binding };
      }
    }
  }
}

/**
 * Cycle check: would adding edge `producer.node → consumer.node` form a cycle?
 * Returns true if a path already exists `consumer → ... → producer`.
 *
 * The walk follows dependency edges upward from `producer`. By default those are
 * the wired `node.inputs` edges. #291 (Epic 1, G6): a driver/overlay dependency is
 * NOT a wired input edge — it is expressed via params (a driven target depends on
 * its source). Pass `paramDeps` (a `consumerId → [producerId, …]` adjacency of
 * those extra dependencies) so a driver cannot close a loop that the input-only
 * walk would miss. Omitting it preserves the exact pre-#291 behavior.
 *
 * REF: THESIS.md §10 (cycle detection by visited-set + depth limit).
 */
export function wouldCreateCycle(
  state: DagState,
  producer: NodeId,
  consumer: NodeId,
  depthLimit = 32,
  paramDeps?: Record<NodeId, NodeId[]>,
): boolean {
  if (producer === consumer) return true;
  const stack: Array<{ id: NodeId; depth: number }> = [{ id: producer, depth: 0 }];
  const visited = new Set<NodeId>();
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    if (id === consumer) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    if (depth >= depthLimit) continue;
    const node = state.nodes[id];
    // A node absent from `state.nodes` can still carry param dependencies below,
    // so we don't `continue` on a missing node — only skip its input edges.
    if (node) {
      for (const binding of Object.values(node.inputs)) {
        const refs = Array.isArray(binding) ? binding : [binding];
        for (const ref of refs) {
          if (!visited.has(ref.node)) stack.push({ id: ref.node, depth: depth + 1 });
        }
      }
    }
    // #291 — also traverse driver/overlay dependencies for this node.
    for (const dep of paramDeps?.[id] ?? []) {
      if (!visited.has(dep)) stack.push({ id: dep, depth: depth + 1 });
    }
  }
  return false;
}
