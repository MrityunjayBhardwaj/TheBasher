// statefulOps — the replay seam for the stateful eval-contract (Epic 2, #297).
//
// This is the ONE place the interval/seed/replay machinery lives (dharana B27's
// "eval-contract" axis). A stateless driver folds a CONSTANT (its value ignores the
// playhead); a STATEFUL relation (Lag/Spring) folds a value that depends on the PAST
// — output(f) = g(input(f), output(f−1)) — so it cannot be a constant and cannot be
// produced by the pure point-in-time evaluator (which sees one frame and has no
// previous output). Instead we hand the fold seam a channel value whose
// `sample(seconds)` RE-INTEGRATES the recurrence from a known seed frame up to
// `frame(seconds)`.
//
// Why this is deterministic (H40 under scrub): the value at frame N is a pure
// function of (seed, the input over [seed,N], the params) — NOT of how the playhead
// got to N. So scrubbing forward, backward, or jumping all replay the same interval
// and land the same value. And because BOTH H40 roads (render fold + read resolve)
// obtain the value by calling this same `sample`, render == read by construction —
// exactly as the stateless driver roads already are. Determinism by a fixed
// seed+interval, NOT by node purity (the Lag node is `pure:false`).
//
// Cost: `sample(seconds)` is O(N − seed) — it re-integrates each call. Fine for a
// handful of driven params over a typical timeline; the replay is bounded (below) so
// a malformed seed can't run away. A cached O(1) history block (invalidate-on-
// backward-scrub) is the later optimization, behind this same `sample` interface.
//
// v1 SCOPE: a single stateful node (Lag) directly feeding a ParamDriver's `in`, whose
// own input is a controller's transform channel (the animated Null — the only
// time-varying scalar road today; a wired compute graph is time-invariant unless fed
// a TimeSource). Chains of stateful nodes, a wired Time→Number source, and Spring are
// follow-ups on this same contract.
//
// REF: ref/GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §5/§5a (Lag/Spring CHOP,
//      Solver SOP); dharana B27; valueMath.lagStep; ParamDriver.makeParamDriverChannelValueFn;
//      transformChannelSource.readTransformChannelAt; issue #297.

import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, Node } from '../core/dag/types';
import { FRAMES_PER_SECOND } from './stores/timeStore';
import { lagStep } from '../nodes/valueMath';
import { makeParamDriverChannelValueFn, type ParamDriverParams } from '../nodes/ParamDriver';
import type { KeyframeChannelNumberValue } from '../nodes/types';
import { transformSourceOf, readTransformChannelAt } from './transformChannelSource';

/** Never integrate more than this many frames back in one `sample`. A first-order
 *  lag with factor > 0 has fully converged long before this; the cap only guards
 *  against a malformed `seedFrame` (e.g. a huge negative) turning one sample into a
 *  runaway loop. */
const MAX_REPLAY_FRAMES = 10_000;

interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** The single wired input ref of a node's `socket`, if any (drivers/Lag use single
 *  cardinality). */
function singleInputRef(node: NodeLike, socket: string): { node?: string } | undefined {
  const binding = node.inputs?.[socket];
  const ref = Array.isArray(binding) ? binding[0] : binding;
  return ref as { node?: string } | undefined;
}

/**
 * The stateful node directly feeding `driverNode`'s wired `in`, or null. Detection is
 * by the node definition's `stateful` flag (Lag today), so it stays type-agnostic:
 * any future stateful op wired into a driver replays through the same path.
 */
export function statefulSourceOf(driverNode: NodeLike, state: DagState): Node | null {
  const srcId = singleInputRef(driverNode, 'in')?.node;
  if (!srcId) return null;
  const src = state.nodes[srcId];
  if (!src) return null;
  return getNodeType(src.type)?.stateful ? src : null;
}

/** The EvalCtx for a specific integer frame — the per-frame clock the replay samples
 *  its input at (so an animated controller resolves to its value AT that frame). */
function ctxAtFrame(frame: number): EvalCtx {
  return { time: { frame, seconds: frame / FRAMES_PER_SECOND, normalized: 0 } };
}

/** The stateful node's input value at `ctx`. v1: a controller transform channel (the
 *  animated Null). If the node carries no transform source, fall back to its wired
 *  `in` (its passthrough evaluate) — time-invariant unless fed a time source, so the
 *  lag simply converges to that constant. A bad evaluate reads 0. */
function statefulInputAt(
  state: DagState,
  node: Node,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): number {
  const src = transformSourceOf(node);
  if (src) return readTransformChannelAt(state, src, ctx, cache);
  try {
    const v = evaluate(state, node.id, { cache, ctx }).value;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * The PURE integration core: replay a first-order lag from `seedFrame` up to
 * `targetFrame`, sampling the input at each frame through `inputAt`. Seed = the input
 * at the seed frame (Houdini's `Input_1`, the original un-lagged value); each
 * subsequent frame closes `factor` of the gap toward that frame's input (`lagStep`).
 * Backward of the seed there is nothing to integrate → the raw input at that frame.
 *
 * Determinism: the result depends ONLY on (inputAt, seedFrame, targetFrame, factor) —
 * not on how the playhead reached `targetFrame`. So a forward scrub, a backward scrub,
 * and a jump all replay the same interval and return the same value (H40). `inputAt`
 * is injected so this stays pure + unit-testable; the impure per-frame source read is
 * {@link statefulInputAt}, applied by {@link replayLag}.
 */
export function integrateLag(
  inputAt: (frame: number) => number,
  seedFrame: number,
  targetFrame: number,
  factor: number,
): number {
  // Lag is the simplest preset of {@link integrate}: seed = the input at the start
  // frame, step = close `factor` of the gap toward this frame's input.
  return integrate(seedFrame, targetFrame, inputAt, (prev, f) => lagStep(prev, inputAt(f), factor));
}

/**
 * The PURE integration core shared by every stateful preset (Lag today, the Solver
 * meta-op below, Spring next). Seed `out` at the start frame via `seedAt`, then fold
 * `step(prev, frame)` forward to `targetFrame`. Before the seed there is no recurrence
 * (start == targetFrame → loop body never runs → the seed value). The window is clamped
 * to {@link MAX_REPLAY_FRAMES} so a malformed seed can't run away.
 *
 * Determinism (H40 under scrub): the result depends ONLY on (seedAt, step, seedFrame,
 * targetFrame) — never on how the playhead reached `targetFrame`. So a forward scrub, a
 * backward scrub, and a jump all replay the same interval and return the same value.
 * `seedAt`/`step` are injected so this stays pure + unit-testable; the impure per-frame
 * reads (a controller channel, a sub-network cook) are bound by the callers.
 */
export function integrate(
  seedFrame: number,
  targetFrame: number,
  seedAt: (frame: number) => number,
  step: (prev: number, frame: number) => number,
): number {
  let start = Math.min(seedFrame, targetFrame);
  if (targetFrame - start > MAX_REPLAY_FRAMES) start = targetFrame - MAX_REPLAY_FRAMES;

  let out = seedAt(start);
  for (let f = start + 1; f <= targetFrame; f++) {
    out = step(out, f);
  }
  return out;
}

/** Replay a Lag node's recurrence up to `frame(targetSeconds)`: bind the impure
 *  per-frame source read to {@link integrateLag}. */
function replayLag(
  state: DagState,
  node: Node,
  targetSeconds: number,
  cache?: EvaluatorCache,
): number {
  const params = (node.params ?? {}) as { factor?: unknown; seedFrame?: unknown };
  const factor = typeof params.factor === 'number' ? params.factor : 0.2;
  const seedFrame = typeof params.seedFrame === 'number' ? Math.round(params.seedFrame) : 0;
  const targetFrame = Math.round(targetSeconds * FRAMES_PER_SECOND);
  return integrateLag(
    (frame) => statefulInputAt(state, node, ctxAtFrame(frame), cache),
    seedFrame,
    targetFrame,
    factor,
  );
}

// ── The Solver meta-op — a user-authored sub-network cooked every frame ────────
//
// The generalization of Lag: instead of a fixed `lagStep`, the per-frame step COOKS
// the Solver's sub-network (the dependency closure of its `body` output node),
// threading the previous frame's output into the network's Prev_Frame leaves and the
// live input into its SolverInput leaves. This is Houdini's Solver SOP — Prev_Frame
// (previous output) + Input_1 (live/seed), cooked every frame — on Basher's scalar
// rail. Reuses everything Lag proved: the integrate core, the replay contract, the
// fold, both H40 roads.

/** The Prev_Frame + SolverInput leaves reachable from a Solver's `body` output node —
 *  the sub-network's feedback + live-input injection points. A pure closure walk over
 *  wired inputs (bounded by `seen`). A NESTED Solver is treated as a leaf boundary (its
 *  own closure is not merged in) — nested solvers are out of v1 scope. */
function collectSolverLeaves(
  state: DagState,
  bodyNodeId: string,
): { prevFrame: string[]; input: string[] } {
  const prevFrame: string[] = [];
  const input: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [bodyNodeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = state.nodes[id];
    if (!node) continue;
    if (node.type === 'PrevFrame') prevFrame.push(id);
    else if (node.type === 'SolverInput') input.push(id);
    // Don't descend into a nested Solver — it manages its own sub-network (v1: unsupported).
    if (id !== bodyNodeId && node.type === 'Solver') continue;
    for (const binding of Object.values(node.inputs)) {
      const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
      for (const ref of refs) {
        const nid = (ref as { node?: string } | undefined)?.node;
        if (typeof nid === 'string' && !seen.has(nid)) stack.push(nid);
      }
    }
  }
  return { prevFrame, input };
}

/** Cook the sub-network once at `frame`, injecting `prev` into every Prev_Frame leaf and
 *  `input` into every SolverInput leaf (evaluate `overrides`). Returns the body node's
 *  value (0 if non-finite / unevaluable). No shared cache: the injection makes the
 *  sub-graph value frame-dependent and it is tiny, so a fresh walk per frame is both
 *  correct (no cross-frame poisoning) and cheap. */
function cookSolverStep(
  state: DagState,
  bodyNodeId: string,
  leaves: { prevFrame: string[]; input: string[] },
  prev: number,
  input: number,
  frame: number,
): number {
  const overrides = new Map<string, unknown>();
  for (const id of leaves.prevFrame) overrides.set(id, prev);
  for (const id of leaves.input) overrides.set(id, input);
  try {
    const v = evaluate(state, bodyNodeId, { ctx: ctxAtFrame(frame), overrides }).value;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Replay a Solver's sub-network up to `frame(targetSeconds)`. Generalizes {@link
 *  replayLag}: the per-frame step cooks the sub-network instead of applying `lagStep`.
 *  Seed = the live input at the seed frame (Houdini Input_1 seeds Prev_Frame; matches
 *  Lag). An unfinished Solver (no `body` wired) falls back to its live input, never NaN. */
function replaySolver(
  state: DagState,
  node: Node,
  targetSeconds: number,
  cache?: EvaluatorCache,
): number {
  const params = (node.params ?? {}) as { seedFrame?: unknown };
  const seedFrame = typeof params.seedFrame === 'number' ? Math.round(params.seedFrame) : 0;
  const targetFrame = Math.round(targetSeconds * FRAMES_PER_SECOND);
  const inputAt = (frame: number) => statefulInputAt(state, node, ctxAtFrame(frame), cache);

  const bodyId = singleInputRef(node, 'body')?.node;
  if (!bodyId || !state.nodes[bodyId]) return inputAt(targetFrame);
  const leaves = collectSolverLeaves(state, bodyId);

  return integrate(seedFrame, targetFrame, inputAt, (prev, frame) =>
    cookSolverStep(state, bodyId, leaves, prev, inputAt(frame), frame),
  );
}

/**
 * Build the folded channel value for a driver whose source is a stateful node. The
 * returned value's `sample(seconds)` re-integrates the recurrence — so it lands in
 * the SAME fold pipeline as every other driver/channel, and both H40 roads consume
 * it identically. The switch on `type` selects the preset: Lag's fixed recurrence, or
 * the Solver meta-op's per-frame sub-network cook (Spring and further presets join here).
 */
export function makeStatefulDriverChannelValue(
  state: DagState,
  driverParams: ParamDriverParams,
  statefulNode: Node,
  cache?: EvaluatorCache,
): KeyframeChannelNumberValue {
  const replay =
    statefulNode.type === 'Solver'
      ? (seconds: number) => replaySolver(state, statefulNode, seconds, cache)
      : (seconds: number) => replayLag(state, statefulNode, seconds, cache);
  return makeParamDriverChannelValueFn(driverParams, replay);
}
