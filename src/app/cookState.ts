// cookState — turn authored params into params at *t*, BEFORE the cook, so the cook does
// not need repairing afterwards (#582, epic #575).
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────────────────
//
// Today `evaluate` is pure over `node.params`, and overlays — channels, strips, drivers,
// transients — are folded downstream at the read and render seams. A geometry handle that
// was minted from stale params is then patched back into shape by `rebuildGeometryRef`.
// That repair has exactly one caller, so whether an animated parameter reaches the screen
// depends on which road you took to look at it: the viewport is correct, the pure
// `evaluate` is stale, and a curve — which has no repair arm at all — simply does not
// repaint (#474).
//
// The correction is to move the fold UPSTREAM of that fork rather than add arms to the
// repair. `evaluate` is untouched; so are its 34 callers. 29 of them already take state as
// a parameter, so a derived state reaches them without a single call site changing.
//
// ── THE TWO TIERS, AND WHY THE DISTINCTION IS NOT AN OPTIMISATION ──────────────────────
//
// An overlay is either constant over `t` or not, and the difference is observable:
//
//   • STATIC — a transient (held edit), a single-keyframe channel, a driver. Folding these
//     per frame would be pure waste, and folding them at all is what fixes #474: a held
//     edit is constant over `t`, so the time-varying set does NOT contain it.
//   • PER-FRAME — a channel with two or more keys, a strip. These must re-resolve as the
//     playhead moves.
//
// `timeDependentNodes` (#578) names the second group, and naming it is what makes the fold
// cheap: a node OUTSIDE the set has a fold that does not depend on `seconds`, so once it is
// in the cache it is never re-resolved again, at any playhead position. That is the whole
// saving, and it is the reason #578 had to land first.
//
// ⚠️ WHICH MEANS THE SET IS TRUSTED, AND THE DIRECTION OF ITS ERROR MATTERS. Over-naming a
// node costs a re-resolve that changes nothing. UNDER-naming one freezes it at whatever
// frame it was first folded at, silently. `timeDependentNodes` is a sound
// over-approximation — it walks reachability rather than per-node transfer functions, so a
// node that discards its animated input is still named — which is the safe side of exactly
// this asymmetry. Omitting the argument entirely means "I am not claiming anything", and
// every overlaid node is re-resolved every call.
//
// The gate pins the property that follows: for a SOUND set, folding with it and folding
// without it produce the same values. Only the work differs.
//
// ── WHY IDENTITY, NOT EQUALITY ─────────────────────────────────────────────────────────
//
// The evaluator memoises `hashValue(node.params)` in a WeakMap keyed on the params OBJECT
// (`core/dag/evaluator.ts`). A fold that returns a fresh-but-equal object every frame
// misses that memo on every node it touches — measured on this tree at 0.001 → 4.77 ms per
// frame for a heavy-params node. So this module preserves object identity in two places,
// both structural rather than best-effort:
//
//   1. A node with no overlay is never rebuilt: it keeps its params object, and the whole
//      state is returned BY REFERENCE when nothing at all was folded.
//   2. A node whose freshly folded values equal the previous call's reuses the previous
//      params object. That is `rebuildGeometryRef`'s discipline — return the input by
//      reference when nothing named applies — and it is copied here rather than reinvented.
//
// The comparison is over the FOLDED PATHS only, never over the whole params object. Hashing
// params to decide whether to reuse them would cost precisely what the memo exists to
// avoid.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────
//
// It does not re-implement the fold. Every value comes from `resolveEvaluatedParam`, the
// same resolver the inspector reads through, which itself samples channel VALUES rather
// than interpolating keyframes by hand. A second interpolator here would drift from the
// renderer, which is the oldest failure at this boundary.
//
// It does not reach across the object↔data split. An overlay is folded onto the node it
// NAMES. The resolver's cross-node fallbacks exist for a surface that has to ask "what is
// this row's value?" without knowing who owns it; a fold already knows, because it starts
// from the overlay. Those fallbacks only fire when a node has no direct overlay, and this
// module only ever asks about pairs that have one.
//
// REF: `src/core/dag/state.ts` (`DagState` / `CookState` — why they are not
//      interchangeable), `src/app/timeDependence.ts` (the per-frame set),
//      `src/app/resolveEvaluatedParam.ts` (the fold this delegates to),
//      `src/app/modifierGeometry.ts` (`rebuildGeometryRef` — the identity discipline),
//      `src/nodes/overlayChannels.ts` (`writeAt` — the one path-writer); issues #582, #575,
//      #474, #524.

import type { CookState, DagState } from '../core/dag/state';
import type { EvalCtx, Node, NodeId } from '../core/dag/types';
import type { EvaluatorCache } from '../core/dag/evaluator';
import { writeAt } from '../nodes/overlayChannels';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { stripChannelValuesForTarget } from './layeredChannels';
import { driverChannelValuesForTarget } from './paramDrivers';
import { isKeyframeChannelNode } from './animate/paramAnimationState';
import { useTransientEditStore } from './stores/transientEditStore';

/** What was folded onto one node last time, so an unchanged fold can reuse its object. */
interface FoldedNode {
  /** The authored params this was folded FROM. A different object ⇒ the author edited. */
  authored: object;
  /** paramPath → the value written, so "did anything actually move?" is cheap. */
  values: Map<string, unknown>;
  /** The params object handed out last time. Reused verbatim when nothing moved. */
  folded: Record<string, unknown>;
  /** The playhead this was folded at — the only thing that can invalidate a static fold. */
  seconds: number;
}

/**
 * Cross-call memo for {@link foldOverlays}. Owned by the caller, exactly like
 * `EvaluatorCache`: a long-lived one (the render root) keeps params object identity stable
 * across frames; omitting it is always correct and merely slower.
 */
export interface FoldCache {
  nodes: Map<NodeId, FoldedNode>;
}

export function createFoldCache(): FoldCache {
  return { nodes: new Map() };
}

/** How much work the fold did. See `foldOverlays`' `opts.counters`. */
export interface FoldCounters {
  /** Calls into `resolveEvaluatedParam` — the expensive half (channel sampling, drivers). */
  resolves: number;
}

/**
 * Every (nodeId, paramPath) an overlay is authored against.
 *
 * Enumerated from the graph rather than from a registry, because the overlay rail is
 * edge-less: a channel, strip or driver names its target in params, and a transient names
 * it in a store. Collecting the candidate TARGETS first keeps this one pass over the node
 * table plus one enumerator call per target that actually has an overlay — not a per-node
 * scan of the whole graph.
 */
function overlaidPaths(
  state: DagState,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Map<NodeId, Set<string>> {
  const out = new Map<NodeId, Set<string>>();
  const add = (nodeId: string, paramPath: string) => {
    if (!nodeId || !paramPath || !state.nodes[nodeId]) return;
    const set = out.get(nodeId);
    if (set) set.add(paramPath);
    else out.set(nodeId, new Set([paramPath]));
  };

  // Candidate targets: anything naming a target in params (channels, strips, drivers).
  const targets = new Set<NodeId>();
  for (const node of Object.values(state.nodes)) {
    const p = node.params as { target?: unknown; paramPath?: unknown };
    if (typeof p?.target !== 'string' || !p.target) continue;
    targets.add(p.target);
    // A bare keyframe channel carries its own paramPath, so it needs no enumerator.
    if (isKeyframeChannelNode(node) && typeof p.paramPath === 'string') add(p.target, p.paramPath);
  }

  // Held edits name their target directly and are the STATIC tier's whole reason to exist.
  for (const edit of useTransientEditStore.getState().edits.values()) {
    add(edit.nodeId, edit.paramPath);
    targets.add(edit.nodeId);
  }

  // Strips and drivers only yield their paths through the enumerators the render seam uses
  // — reusing them is what keeps this from becoming a second spelling of either rail.
  for (const targetId of targets) {
    if (!state.nodes[targetId]) continue;
    for (const v of stripChannelValuesForTarget(state.nodes, targetId)) add(targetId, v.paramPath);
    for (const v of driverChannelValuesForTarget(state, targetId, ctx, cache))
      add(targetId, v.paramPath);
  }

  return out;
}

/** Structural equality over ONE folded value (a scalar, a vec, a small record). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

/**
 * Derive the state the cook should see: authored params with every overlay folded in at
 * `seconds`.
 *
 * @param authored    the state as the director wrote it (what the store holds).
 * @param seconds     the playhead.
 * @param timeVarying nodes whose overlays vary over `t`, from `timeDependentNodes`. A
 *                    node outside it is folded once and never re-resolved, so the set is
 *                    TRUSTED: over-naming costs work, under-naming freezes a value. Omit
 *                    it to claim nothing and re-resolve everything.
 * @param opts.cache  the evaluator cache, threaded into channel and driver evaluation.
 * @param opts.fold   cross-call memo; supply a stable one to keep params object identity
 *                    across frames, which is what keeps the evaluator's params-hash memo
 *                    alive.
 * @param opts.counters
 *                    counts calls into the resolver. The two skips above are FREQUENCY
 *                    claims — they change how much work happens, never what comes out — so
 *                    no value assertion can witness them and the gate needs a count.
 *
 * Returns `authored` BY REFERENCE when no overlay exists anywhere — with no overlays the
 * authored params already ARE the params at `t`, so the two states coincide and there is
 * nothing to copy.
 */
export function foldOverlays(
  authored: DagState,
  seconds: number,
  timeVarying?: ReadonlySet<NodeId>,
  opts?: { cache?: EvaluatorCache; fold?: FoldCache; counters?: FoldCounters },
): CookState {
  const ctx: EvalCtx = { time: { frame: Math.round(seconds * 30), seconds, normalized: 0 } };
  const paths = overlaidPaths(authored, ctx, opts?.cache);
  if (paths.size === 0) return authored as unknown as CookState;

  const foldCache = opts?.fold;
  let changedAny = false;
  const nodes: Record<NodeId, Node> = {};

  for (const [id, node] of Object.entries(authored.nodes)) {
    const overlaid = paths.get(id);
    if (!overlaid) {
      nodes[id] = node; // untouched — keeps its params object, keeps its memo entry
      continue;
    }

    const prev = foldCache?.nodes.get(id);
    const authoredUnchanged = prev !== undefined && prev.authored === node.params;

    // ── THE SKIP THE TIME-VARYING SET BUYS ──────────────────────────────────────────
    // A node the caller did NOT name as time-varying folds to a value that does not
    // depend on `seconds`, so a cached fold stays valid at every playhead position. That
    // is the saving: the resolve below — which samples channels and evaluates drivers —
    // never runs again for a held edit or a single-key channel. Skipped only when the
    // caller made the claim (an omitted set claims nothing) and the author has not edited
    // underneath.
    //
    // The `prev.seconds === seconds` arm is the other half, and it needs no claim from
    // anyone: re-folding at a playhead position already folded at cannot produce a
    // different value. That is the common case during a paused re-render, where React
    // re-runs while nothing about time has moved.
    const staticHere = timeVarying !== undefined && !timeVarying.has(id);
    if (authoredUnchanged && (prev.seconds === seconds || staticHere)) {
      nodes[id] = { ...node, params: prev.folded };
      changedAny = true;
      continue;
    }

    // Resolve each overlaid path through the SAME resolver every read surface uses.
    const values = new Map<string, unknown>();
    for (const paramPath of overlaid) {
      if (opts?.counters) opts.counters.resolves++;
      const resolved = resolveEvaluatedParam(authored, id, paramPath, ctx, opts?.cache);
      if (resolved) values.set(paramPath, resolved.value);
    }
    if (values.size === 0) {
      nodes[id] = node;
      continue;
    }

    // Identity preservation: a node that IS time-varying but whose value has not actually
    // moved this frame keeps last frame's params object, so the evaluator's params-hash
    // memo survives. Compared over the folded PATHS only — hashing the params to decide
    // would cost exactly what the memo exists to avoid.
    const unchanged =
      authoredUnchanged &&
      prev.values.size === values.size &&
      [...values].every(([k, v]) => prev.values.has(k) && sameValue(prev.values.get(k), v));
    if (unchanged) {
      nodes[id] = { ...node, params: prev.folded };
      changedAny = true;
      continue;
    }

    const folded = JSON.parse(JSON.stringify(node.params)) as Record<string, unknown>;
    for (const [paramPath, value] of values) writeAt(folded, paramPath, value);
    foldCache?.nodes.set(id, { authored: node.params as object, values, folded, seconds });
    nodes[id] = { ...node, params: folded };
    changedAny = true;
  }

  if (!changedAny) return authored as unknown as CookState;
  return { nodes, outputs: authored.outputs, paramsAt: 'cooked' };
}
