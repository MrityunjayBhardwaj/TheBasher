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
// Cost: a raw `sample(seconds)` is O(N − seed) — it re-integrates each call. That is
// O(1)-cached below (`cachedIntegrate`): the per-frame states are memoized behind this
// SAME `sample` interface, keyed by the DAG state identity (fresh per edit, stable across
// scrub), so a static graph scrubs/plays in O(1) amortized. The replay is bounded (below)
// so a malformed seed can't run away even on the uncached (clamp-regime) path.
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

import { evaluate, setStatefulReplay, type EvaluatorCache } from '../core/dag/evaluator';
import { arriving, producedTypeOf } from '../core/dag/socketConversion';
import { getNodeType, registryEpoch } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import {
  bindBodyInputs,
  bodyInputLeavesOf,
  holdersOf,
  type BodyInputLeaf,
} from '../core/dag/subnetworks';
import { LIVE_INPUT, REPLAY_INPUTS, TEMPLATE_TYPE_PREFIX } from '../core/dag/templates';
import type { EvalCtx, Node } from '../core/dag/types';
import { FRAMES_PER_SECOND } from './stores/timeStore';
import { lagStep } from '../nodes/valueMath';
import {
  makeParamDriverChannelValueFn,
  makeParamDriverVec3ChannelValueFn,
  type ParamDriverParams,
} from '../nodes/ParamDriver';
import type { KeyframeChannelValue, Vec3 } from '../nodes/types';
import {
  transformSourceOf,
  transformVecSourceOf,
  readTransformChannelAt,
  readTransformPositionAt,
} from './transformChannelSource';

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
function singleInputRef(
  node: NodeLike,
  socket: string,
): { node?: string; socket?: string } | undefined {
  const binding = node.inputs?.[socket];
  const ref = Array.isArray(binding) ? binding[0] : binding;
  return ref as { node?: string; socket?: string } | undefined;
}

/**
 * The stateful node directly feeding `driverNode`'s wired `in`, or null. Detection is
 * by the node definition's `stateful` flag (Lag today), so it stays type-agnostic:
 * any future stateful op wired into a driver replays through the same path.
 */
export function statefulSourceOf(driverNode: NodeLike, state: DagState): Node | null {
  // A stateful op can drive a scalar target OR a Vector3 target (S #300 — a vec
  // Solver/spring driving a position). Both arrive on the same `in` socket since #609,
  // so there is one road to check rather than two that had to be kept in sync.
  const srcId = singleInputRef(driverNode, 'in')?.node;
  if (!srcId) return null;
  const src = state.nodes[srcId];
  if (!src) return null;
  return getNodeType(src.type)?.stateful ? src : null;
}

/** The wired refs of a node's MULTI-cardinality `socket` (the Solver's `bodies`), in
 *  wire order = slot order. Empty when unwired. */
function multiInputRefs(node: NodeLike, socket: string): { node: string; socket: string }[] {
  const binding = node.inputs?.[socket];
  const arr = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return arr.filter(
    (r): r is { node: string; socket: string } =>
      !!r && typeof (r as { node?: unknown }).node === 'string',
  );
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
}

const ORIGIN: Vec3 = [0, 0, 0];

/** The EvalCtx for a specific integer frame — the per-frame clock the replay samples
 *  its input at (so an animated controller resolves to its value AT that frame). */
function ctxAtFrame(frame: number): EvalCtx {
  return { time: { frame, seconds: frame / FRAMES_PER_SECOND, normalized: 0 } };
}

/** The stateful node's input value at `ctx`. v1: a controller transform channel (the
 *  animated Null). If the node carries no transform source, fall back to its wired
 *  `in` (its passthrough evaluate) — time-invariant unless fed a time source, so the
 *  lag simply converges to that constant. A bad evaluate reads 0. */
// #1559 — what a stateful node inside a template reads from the instance holding it (Houdini: an
// asset's promoted parameters, read by the node inside): the controller it trails when it names
// none and has nothing wired, the instance's `in` when no controller is named at all (a Lag's own
// order), and the frame its replay starts from. The nearest template instance whose sub-network
// holds the node and that declares any of these. Only a template's: an outer Solver's own
// controller is its own input, not a default for the nodes it holds. Worked out once per node
// table and registry epoch (which nodes hold which depends on types, #1647).
const enclosingInstances = new WeakMap<
  object,
  { readonly epoch: number; readonly byNode: Map<string, Node | null> }
>();
function holdsReplayInputs(node: Node): boolean {
  if (!node.type.startsWith(TEMPLATE_TYPE_PREFIX)) return false;
  const def = getNodeType(node.type);
  const params = (def?.paramSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
  return (
    Object.values(REPLAY_INPUTS).some((name) => name in params) || LIVE_INPUT in (def?.inputs ?? {})
  );
}
function enclosingInstance(state: DagState, nodeId: string): Node | null {
  const known = enclosingInstances.get(state.nodes);
  let byNode = known && known.epoch === registryEpoch() ? known.byNode : undefined;
  if (!byNode) {
    byNode = new Map();
    enclosingInstances.set(state.nodes, { epoch: registryEpoch(), byNode });
  }
  if (!byNode.has(nodeId)) {
    const owner = holdersOf(state, nodeId)
      .map((id) => state.nodes[id])
      .find(holdsReplayInputs);
    byNode.set(nodeId, owner ?? null);
  }
  return byNode.get(nodeId)!;
}

/** The frame a stateful node's replay starts from: the enclosing instance's when it holds one. */
function seedFrameOf(state: DagState, node: Node): number {
  const owner = enclosingInstance(state, node.id);
  const held = (owner?.params as { seedFrame?: unknown } | undefined)?.seedFrame;
  const own = (node.params as { seedFrame?: unknown } | undefined)?.seedFrame;
  const v = typeof held === 'number' ? held : own;
  return typeof v === 'number' ? Math.round(v) : 0;
}

/** An instance's `in` at `ctx`: what is wired into it, else its own value (#1557 D6). */
function liveInputOf(state: DagState, owner: Node, ctx: EvalCtx, cache?: EvaluatorCache): number {
  const ref = singleInputRef(owner, LIVE_INPUT);
  if (!ref?.node) {
    const v = (owner.params as Record<string, unknown> | undefined)?.[LIVE_INPUT];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
  try {
    const v = evaluate(state, ref.node, { cache, ctx, socket: ref.socket }).value;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function statefulInputAt(
  state: DagState,
  node: Node,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): number {
  const src = transformSourceOf(node);
  if (src) return readTransformChannelAt(state, src, ctx, cache);
  // The producer of `in`, never the node itself: the evaluator answers a stateful node with
  // this replay (#1558), so asking it for the node here would never return.
  const ref = singleInputRef(node, 'in');
  if (!ref?.node) {
    const owner = enclosingInstance(state, node.id);
    if (!owner) return 0;
    const held = transformSourceOf(owner);
    return held
      ? readTransformChannelAt(state, held, ctx, cache)
      : liveInputOf(state, owner, ctx, cache);
  }
  try {
    const v = evaluate(state, ref.node, { cache, ctx, socket: ref.socket }).value;
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
export function integrate<T>(
  seedFrame: number,
  targetFrame: number,
  seedAt: (frame: number) => T,
  step: (prev: T, frame: number) => T,
): T {
  let start = Math.min(seedFrame, targetFrame);
  if (targetFrame - start > MAX_REPLAY_FRAMES) start = targetFrame - MAX_REPLAY_FRAMES;

  let out = seedAt(start);
  for (let f = start + 1; f <= targetFrame; f++) {
    out = step(out, f);
  }
  return out;
}

// ── O(1) history cache (the perf follow-up flagged in the header) ──────────────
//
// `integrate` re-walks [seed..target] on EVERY sample, so a full scrub/playback of a
// Solver is O(frames² × subgraph). The cache stores the integrated state per frame so a
// sample continues from the last computed frame (forward scrub → O(1) amortized) or reads
// a stored frame directly (backward scrub → O(1) lookup). Both roads return the SAME value
// `integrate` would (the block is built by the SAME `seedAt`/`step`, forward, in order), so
// determinism under scrub (H40) is preserved — the cache is transparent.
//
// COARSE-EPOCH invalidation, keyed by the DagState IDENTITY: an immutable op replaces the
// whole state object on every dispatch, but the reference is STABLE across pure
// scrub/playback (the time store is separate). So a `WeakMap<DagState>` keeps ONE entry a
// static graph reuses for every sample (full O(1) benefit), and ANY edit yields a new state
// → a fresh (empty) cache while the old blocks GC — a block can NEVER be stale (sound by
// construction, no dependency hashing). Storage is the full history [seed..max] so a
// backward scrub is an O(1) lookup, which H40 leans on.

interface HistoryBlock<T> {
  readonly seedFrame: number;
  /** states[i] = the integrated state at frame `seedFrame + i` (built forward, in order). */
  readonly states: T[];
}

// What a step computes depends on the types of the nodes it cooks, so the history is kept with
// the registry's epoch and started again once a type is redefined (#1647).
const historyCache = new WeakMap<
  DagState,
  { readonly epoch: number; readonly perNode: Map<string, HistoryBlock<unknown>> }
>();

/**
 * Cached {@link integrate}: same result, but the per-frame states are memoized per
 * (DagState identity, nodeId) so repeated samples across a scrub are O(1) amortized instead
 * of O(frames) each. Frames before the seed (no recurrence) and the runaway-clamp regime
 * (beyond {@link MAX_REPLAY_FRAMES}, a moving start no real timeline reaches) bypass the
 * cache and defer to the uncached path.
 */
export function cachedIntegrate<T>(
  state: DagState,
  nodeId: string,
  seedFrame: number,
  targetFrame: number,
  seedAt: (frame: number) => T,
  step: (prev: T, frame: number) => T,
): T {
  if (targetFrame <= seedFrame) return seedAt(targetFrame); // before the seed: no recurrence
  if (targetFrame - seedFrame > MAX_REPLAY_FRAMES) {
    return integrate(seedFrame, targetFrame, seedAt, step); // clamp regime → uncached, bounded
  }
  const known = historyCache.get(state);
  let perNode = known && known.epoch === registryEpoch() ? known.perNode : undefined;
  if (!perNode) {
    perNode = new Map();
    historyCache.set(state, { epoch: registryEpoch(), perNode });
  }
  let block = perNode.get(nodeId) as HistoryBlock<T> | undefined;
  if (!block || block.seedFrame !== seedFrame) {
    block = { seedFrame, states: [seedAt(seedFrame)] };
    perNode.set(nodeId, block as HistoryBlock<unknown>);
  }
  // Extend forward to targetFrame if this epoch hasn't reached it yet (amortized O(1)/frame).
  for (let f = block.seedFrame + block.states.length; f <= targetFrame; f++) {
    block.states.push(step(block.states[block.states.length - 1], f));
  }
  return block.states[targetFrame - block.seedFrame];
}

/** Replay a Lag node's recurrence up to `frame(targetSeconds)`: bind the impure
 *  per-frame source read to {@link integrateLag}. */
function replayLag(
  state: DagState,
  node: Node,
  targetSeconds: number,
  cache?: EvaluatorCache,
): number {
  const params = (node.params ?? {}) as { factor?: unknown };
  const factor = typeof params.factor === 'number' ? params.factor : 0.2;
  const seedFrame = seedFrameOf(state, node);
  const targetFrame = Math.round(targetSeconds * FRAMES_PER_SECOND);
  const inputAt = (frame: number) => statefulInputAt(state, node, ctxAtFrame(frame), cache);
  // The Lag preset of the cached integrator (its pure oracle is `integrateLag`).
  return cachedIntegrate(state, node.id, seedFrame, targetFrame, inputAt, (prev, f) =>
    lagStep(prev, inputAt(f), factor),
  );
}

// ── The Solver meta-op — a user-authored sub-network cooked every frame ────────
//
// The generalization of Lag: instead of a fixed `lagStep`, the per-frame step COOKS
// the Solver's sub-network (the dependency closure of its `body` output node),
// binding the previous frame's output to the network's `prev` input and the
// live input into the leaves that read `input` (#1548). This is Houdini's Solver SOP — Prev_Frame
// (previous output) + Input_1 (live/seed), cooked every frame — on Basher's scalar
// rail. Reuses everything Lag proved: the integrate core, the replay contract, the
// fold, both H40 roads.

/** Cook the sub-network once at `frame`, binding `prev` and `input` to the leaves that read
 *  them (#1548, evaluate `overrides`). Returns the body node's value (0 if non-finite /
 *  unevaluable). No shared cache: the binding makes the sub-graph value frame-dependent and
 *  it is tiny, so a fresh walk per frame is both correct (no cross-frame poisoning) and
 *  cheap. */
function cookSolverStep(
  state: DagState,
  solverId: string,
  body: { node: string; socket?: string },
  leaves: readonly BodyInputLeaf[],
  prev: number,
  input: number,
  frame: number,
): number {
  const overrides = bindBodyInputs(state, solverId, leaves, { prev, input });
  try {
    // The wired OUTPUT, not the node's whole value: a body with more than one output (another
    // Solver, #1558) evaluates to a record, and reading that as a number gave 0.
    const v = evaluate(state, body.node, {
      ctx: ctxAtFrame(frame),
      overrides,
      socket: body.socket,
    }).value;
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
  const seedFrame = seedFrameOf(state, node);
  const targetFrame = Math.round(targetSeconds * FRAMES_PER_SECOND);
  const inputAt = (frame: number) => statefulInputAt(state, node, ctxAtFrame(frame), cache);

  const bodyRef = singleInputRef(node, 'body');
  const bodyId = bodyRef?.node;
  if (!bodyId || !state.nodes[bodyId]) return inputAt(targetFrame);
  const body = { node: bodyId, socket: bodyRef.socket };
  const leaves = bodyInputLeavesOf(state, node.id);

  return cachedIntegrate(state, node.id, seedFrame, targetFrame, inputAt, (prev, frame) =>
    cookSolverStep(state, node.id, body, leaves, prev, inputAt(frame), frame),
  );
}

// ── The TUPLE-state Solver — vec state (S, #300, the 2nd-order Spring) ─────────
//
// A scalar Solver carries ONE number forward; a 2nd-order spring's state is TWO Vec3s
// (position + velocity), so the vec Solver carries a Vec3[] tuple. `bodies[i]` is the
// sub-network output for slot i (bodies[0] = new position, bodies[1] = new velocity);
// `prevVec` element `slot` feeds back prevState[slot]; `inputVec` binds the live target
// vector (a controller's whole position, the F2b Point road). The Solver's driven value
// is slot 0 (position). Everything else — the seed+interval replay, determinism under
// scrub, both H40 roads calling one `sample` — is EXACTLY Lag's/the scalar Solver's
// contract, only the state type widens (number → Vec3[]).

/** True for a Solver in VEC/tuple mode: its `bodies` (Vector3 multi) input is wired.
 *  A scalar Solver (only `body` wired) stays on the byte-identical scalar path. */
function isVecSolver(node: NodeLike): boolean {
  return node.type === 'Solver' && multiInputRefs(node, 'bodies').length > 0;
}

/** The vec live-input of a Solver at `ctx`: its `sourceTransformVec` controller's whole
 *  evaluated position (the F2b Point road). No source ⇒ origin (a pure-feedback solver). */
function statefulInputVecAt(
  state: DagState,
  node: Node,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): Vec3 {
  const own = transformVecSourceOf(node);
  const owner = own ? null : enclosingInstance(state, node.id);
  const src = own ?? (owner && transformVecSourceOf(owner));
  return src ? readTransformPositionAt(state, src.node, ctx, cache) : ORIGIN;
}

/** Cook the tuple sub-network once at `frame`: bind `prevVec` (element `slot` = prevState
 *  [slot]) and `inputVec` (the live target), then evaluate each `bodies[i]` → the new value of
 *  slot i. Returns the full new state tuple. No shared cache — the binding makes the
 *  sub-graph frame-dependent (as the scalar cook). */
function cookSolverVecStep(
  state: DagState,
  solverId: string,
  bodyRefs: { node: string; socket: string }[],
  leaves: readonly BodyInputLeaf[],
  prevState: Vec3[],
  input: Vec3,
  frame: number,
): Vec3[] {
  const overrides = bindBodyInputs(state, solverId, leaves, {
    prevVec: prevState,
    inputVec: input,
  });
  const ctx = ctxAtFrame(frame);
  const bodiesInto = getNodeType(state.nodes[solverId]?.type ?? '')?.inputs.bodies;
  return bodyRefs.map((ref) => {
    try {
      // A body is read here, not through the Solver's own input resolution, so what the wire
      // carries is converted here as it would be there (#1549: a Number body fills all three
      // axes).
      const v = arriving(
        bodiesInto,
        producedTypeOf(state, ref),
        evaluate(state, ref.node, { ctx, overrides, socket: ref.socket }).value,
      );
      return isVec3(v) ? v : ORIGIN;
    } catch {
      return ORIGIN;
    }
  });
}

/** Replay a vec/tuple Solver up to `frame(targetSeconds)`, returning slot 0 (the driven
 *  position). Seed: slot 0 = the live target at the seed frame (the spring starts at
 *  rest ON the target, Houdini's Input_1-seeds-Prev_Frame), every other slot = origin
 *  (zero velocity). Determinism (H40 under scrub): identical to the scalar path — the
 *  value at N is a pure function of (seed, target over [seed,N], the sub-network). */
function replaySolverVec(
  state: DagState,
  node: Node,
  targetSeconds: number,
  cache?: EvaluatorCache,
): Vec3 {
  const seedFrame = seedFrameOf(state, node);
  const targetFrame = Math.round(targetSeconds * FRAMES_PER_SECOND);
  const bodyRefs = multiInputRefs(node, 'bodies');
  const inputAt = (frame: number) => statefulInputVecAt(state, node, ctxAtFrame(frame), cache);
  if (bodyRefs.length === 0) return inputAt(targetFrame); // unfinished → the target, never NaN

  const slots = bodyRefs.length;
  const leaves = bodyInputLeavesOf(state, node.id);
  const seedState = (frame: number): Vec3[] => {
    const s: Vec3[] = new Array(slots).fill(ORIGIN);
    s[0] = inputAt(frame); // slot 0 (position) starts on the target; other slots = origin
    return s;
  };
  const result = cachedIntegrate<Vec3[]>(
    state,
    node.id,
    seedFrame,
    targetFrame,
    seedState,
    (prev, frame) =>
      cookSolverVecStep(state, node.id, bodyRefs, leaves, prev, inputAt(frame), frame),
  );
  return result[0] ?? ORIGIN;
}

/**
 * Build the folded channel value for a driver whose source is a stateful node. The
 * returned value's `sample(seconds)` re-integrates the recurrence — so it lands in
 * the SAME fold pipeline as every other driver/channel, and both H40 roads consume
 * it identically. Selects the preset: a vec/tuple Solver folds a Vec3 channel (the
 * Spring driving a position); a scalar Solver / Lag folds a Number channel.
 */
export function makeStatefulDriverChannelValue(
  state: DagState,
  driverParams: ParamDriverParams,
  statefulNode: Node,
  cache?: EvaluatorCache,
): KeyframeChannelValue {
  if (isVecSolver(statefulNode)) {
    return makeParamDriverVec3ChannelValueFn(driverParams, (seconds) =>
      replaySolverVec(state, statefulNode, seconds, cache),
    );
  }
  const replay =
    statefulNode.type === 'Solver'
      ? (seconds: number) => replaySolver(state, statefulNode, seconds, cache)
      : (seconds: number) => replayLag(state, statefulNode, seconds, cache);
  return makeParamDriverChannelValueFn(driverParams, replay);
}

// ── The evaluator's road to the replay (#1558) ─────────────────────────────────
//
// What a stateful node evaluates to at `ctx.time`, for every consumer that is not a driver
// reading it directly: a compute node behind it, another owner's sub-network holding it. Shaped
// like the node's own output, so a consumer picks a socket off it as it would off `evaluate`.
// A Solver gives both faces; the one whose body is unwired reads what its replay reads for an
// unfinished Solver (the live input, or the origin).
//
// COST, MEASURED 2026-10-07 (vitest, node; a Math node behind a Solver that holds another
// Solver, asked at frame 600): 32 ms for the first ask, which integrates both from their seed,
// then 0.05 ms a frame going forward, because the history is kept per graph object
// (`cachedIntegrate`). Handed a NEW graph object every frame the history is rebuilt each time:
// 17 ms a frame at that depth. Every caller today passes the authored graph, which is stable
// across a scrub; a caller that passes a per-frame fold of it would pay that.
//
// A node asked for while its own replay is running is a loop through a reference (a Lag whose
// controller is driven by that Lag). It throws, and every caller of a replay reads a thrown
// evaluate as 0.
const replaying = new Set<string>();
export function replayStatefulAt(
  state: DagState,
  nodeId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): unknown {
  const node = state.nodes[nodeId];
  if (!node) throw new Error(`replayStatefulAt: node not found: ${nodeId}`);
  if (replaying.has(nodeId)) {
    throw new Error(`replayStatefulAt: "${nodeId}" is read by its own replay`);
  }
  replaying.add(nodeId);
  try {
    const seconds = ctx.time.seconds;
    if (node.type === 'Lag') return replayLag(state, node, seconds, cache);
    if (node.type === 'Solver') {
      return {
        out: replaySolver(state, node, seconds, cache),
        outVec: isVecSolver(node) ? replaySolverVec(state, node, seconds, cache) : ORIGIN,
      };
    }
    // A stateful type this seam has no recurrence for. Answering it as a Lag would hand back a
    // plausible number for a node nobody integrated.
    throw new Error(`replayStatefulAt: no replay for stateful type ${node.type} ("${nodeId}")`);
  } finally {
    replaying.delete(nodeId);
  }
}

/** Hands the evaluator its road to the replay. Called by `registerAllNodes`, beside the types
 *  that need it; kept here so only this module, which already evaluates, names the evaluator. */
export function registerStatefulReplay(): void {
  setStatefulReplay(replayStatefulAt);
}

/** The wired `in` of a driver whose value can change with time because a stateful node sits
 *  somewhere behind it, though not directly on it (that case is {@link statefulSourceOf}'s). */
export function statefulUpstreamOf(
  driverNode: NodeLike,
  state: DagState,
): { node: string; socket: string } | null {
  const ref = singleInputRef(driverNode, 'in');
  if (!ref?.node || typeof ref.socket !== 'string') return null;
  const seen = new Set<string>();
  const stack = [ref.node];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = state.nodes[id];
    if (!node) continue;
    if (getNodeType(node.type)?.stateful) return { node: ref.node, socket: ref.socket };
    for (const binding of Object.values(node.inputs)) {
      for (const r of Array.isArray(binding) ? binding : [binding]) stack.push(r.node);
    }
  }
  return null;
}

/**
 * The folded channel value for a driver with a stateful node somewhere behind its `in`. The
 * plain road folds the number the graph gives at the moment it is resolved, which is right only
 * while that number does not move with time. Here `sample(seconds)` evaluates the graph AT
 * `seconds`, so a reader that resolves once and samples many times (the two roads that must
 * agree, render and read) gets the replayed value at each, as it does for a direct source.
 * Scalar or vector is decided by what the graph gives now, as `ParamDriver.evaluate` decides it.
 */
export function makeStatefulUpstreamDriverChannelValue(
  state: DagState,
  driverParams: ParamDriverParams,
  source: { node: string; socket: string },
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): KeyframeChannelValue {
  const at = (seconds: number): unknown => {
    try {
      const frame = Math.round(seconds * FRAMES_PER_SECOND);
      return evaluate(state, source.node, {
        cache,
        ctx: { time: { frame, seconds, normalized: 0 } },
        socket: source.socket,
      }).value;
    } catch {
      return undefined;
    }
  };
  if (isVec3(at(ctx.time.seconds))) {
    return makeParamDriverVec3ChannelValueFn(driverParams, (seconds) => {
      const v = at(seconds);
      return isVec3(v) ? v : ORIGIN;
    });
  }
  return makeParamDriverChannelValueFn(driverParams, (seconds) => {
    const v = at(seconds);
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
}
