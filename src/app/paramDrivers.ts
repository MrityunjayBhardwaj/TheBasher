// paramDrivers — the ONE enumeration seam for ParamDriver overlays (#293, Inc 2).
//
// The pull-rail analogue of nodeChannels.ts (bare channels) + layeredChannels.ts
// (strips): the single place a `ParamDriver` node's evaluated output is turned into
// the `KeyframeChannelValue` that BOTH fold seams already consume — the render side
// (SceneFromDAG `useLayeredChannels` → overlayChannels) AND the read side
// (`resolveEvaluatedParam`). Because both route through here, a bound driver lights up
// render AND read at once (H40 — the one-consumer trap closed by construction, exactly
// as strips did in Slice C).
//
// A driver differs from a channel in ONE way: its value comes from the compute graph
// (a real wired `in` edge), so it needs the EVALUATOR (state + ctx + cache), not just
// `node.params`. Hence this module takes `state`, unlike `directChannelValuesForTarget`
// (params-only). The driver's `evaluate` already returns a KeyframeChannelValue, so the
// fold downstream is byte-identical to a channel's.
//
// REF: ref/GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §0/§7 (G1/G6); ParamDriver.ts;
//      resolveEvaluatedParam.ts; SceneFromDAG useLayeredChannels; vyapti V88; issue #293.

import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeId, Node } from '../core/dag/types';
import type { KeyframeChannelValue } from '../nodes/types';
import {
  makeParamDriverChannelValue,
  makeParamDriverVec3ChannelValue,
  type ParamDriverParams,
} from '../nodes/ParamDriver';
import { readBaseParam } from './readBaseParam';
import {
  transformSourceOf,
  transformVecSourceOf,
  readTransformChannelAt,
  readTransformPositionAt,
} from './transformChannelSource';
import { statefulSourceOf, makeStatefulDriverChannelValue } from './statefulOps';

interface NodeLike {
  readonly id: string;
  readonly type: string;
  readonly params?: unknown;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

interface DriverParams {
  target?: unknown;
  paramPath?: unknown;
  sourceSpare?: { node?: unknown; key?: unknown };
  // `sourceTransform` is parsed by the shared `transformSourceOf`, not here.
}

/** The spare-param source ref of a driver, if it pulls from a promoted spare (the
 *  `ch()` road) rather than a wired `in` edge. Null for an Inc-2 wired driver. */
function spareSourceOf(node: NodeLike): { node: string; key: string } | null {
  const s = ((node.params ?? {}) as DriverParams).sourceSpare;
  if (s && typeof s.node === 'string' && typeof s.key === 'string' && s.node && s.key) {
    return { node: s.node, key: s.key };
  }
  return null;
}

/** True for a ParamDriver node that is actually BOUND (has a target + paramPath). An
 *  unbound driver (freshly added, not yet pointed at a param) overlays nothing. */
function isBoundDriver(node: NodeLike): boolean {
  if (node.type !== 'ParamDriver') return false;
  const p = (node.params ?? {}) as DriverParams;
  return (
    typeof p.target === 'string' && !!p.target && typeof p.paramPath === 'string' && !!p.paramPath
  );
}

/**
 * The ParamDriver nodes bound to `targetId` — stable refs so a render subscriber can
 * shallow-compare (an unrelated edit leaves each ref untouched → no re-render, H48).
 * See {@link driverSubscriptionNodesForTarget} for the render memo dep (includes the
 * compute-graph closure so a SOURCE edit also rebuilds).
 */
export function driverNodesForTarget<T extends NodeLike>(
  nodes: Readonly<Record<string, T>>,
  targetId: string,
): T[] {
  if (!targetId) return [];
  const out: T[] = [];
  for (const node of Object.values(nodes)) {
    if (!isBoundDriver(node)) continue;
    if (((node.params ?? {}) as DriverParams).target !== targetId) continue;
    out.push(node);
  }
  return out;
}

/**
 * The render-subscription node set for `targetId`'s drivers: each bound ParamDriver
 * PLUS its transitive input-edge closure (the compute nodes feeding `in`). A render
 * memo keyed off this array (shallow) rebuilds the driven value only when the driver
 * OR any upstream source ref actually changes — the synthesized dependency edge on the
 * render side (V88 N2). The driver→target relation is edge-less (resolved by the
 * target's follower), so it is NOT walked here; only the real wired `in` closure is.
 */
export function driverSubscriptionNodesForTarget<T extends NodeLike>(
  nodes: Readonly<Record<string, T>>,
  targetId: string,
): T[] {
  const drivers = driverNodesForTarget(nodes, targetId);
  if (drivers.length === 0) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  const stack: string[] = [];
  for (const d of drivers) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
    stack.push(d.id);
    // #294 — a spare-sourced driver has NO wired `in` edge, so the input-edge walk
    // below cannot reach its source node. Add it explicitly so a dock/inspector edit
    // to the promoted spare rebuilds the render memo (H48 — the synthesized dep edge
    // for the spare road).
    const spare = spareSourceOf(d);
    if (spare && !seen.has(spare.node)) {
      seen.add(spare.node);
      const src = nodes[spare.node];
      if (src) out.push(src);
      // Not pushed on `stack`: the spare value is a leaf, no further input closure.
    }
    // #296 — same for the transform road: subscribe the controller node so a gizmo
    // drag / param edit on it rebuilds the render memo (H48). Its channels (if
    // animated) re-render per frame already; here we only need the direct-edit path.
    const transform = transformSourceOf(d);
    if (transform && !seen.has(transform.node)) {
      seen.add(transform.node);
      const src = nodes[transform.node];
      if (src) out.push(src);
    }
    // #300 F2b — the vec controller road: subscribe the Point-controller node so a
    // gizmo drag / param edit on it rebuilds the render memo (H48), like the scalar road.
    const transformVec = transformVecSourceOf(d);
    if (transformVec && !seen.has(transformVec.node)) {
      seen.add(transformVec.node);
      const src = nodes[transformVec.node];
      if (src) out.push(src);
    }
  }
  // Walk UP the wired input edges (bounded by `seen`), collecting the compute closure.
  while (stack.length) {
    const node = nodes[stack.pop()!];
    if (!node) continue;
    // #297 — a node in the closure (a Lag, or a Solver #300) may read a controller
    // through a transform-source PARAM REF (not a wired edge), which the input walk
    // below can't reach. Subscribe that controller so a gizmo drag on it rebuilds the
    // render memo. Both roads: a scalar channel (Lag/scalar Solver) and the vec whole-
    // position (a vec Solver / spring's SolverInputVec).
    const xf = transformSourceOf(node);
    if (xf && !seen.has(xf.node)) {
      seen.add(xf.node);
      const src = nodes[xf.node];
      if (src) out.push(src);
    }
    const xfVec = transformVecSourceOf(node);
    if (xfVec && !seen.has(xfVec.node)) {
      seen.add(xfVec.node);
      const src = nodes[xfVec.node];
      if (src) out.push(src);
    }
    if (!node.inputs) continue;
    for (const binding of Object.values(node.inputs)) {
      const refs = Array.isArray(binding) ? binding : binding ? [binding] : [];
      for (const ref of refs) {
        const id = (ref as { node?: string } | undefined)?.node;
        if (typeof id !== 'string' || seen.has(id)) continue;
        seen.add(id);
        const up = nodes[id];
        if (up) {
          out.push(up);
          stack.push(id);
        }
      }
    }
  }
  return out;
}

/**
 * The set of node ids that have at least one BOUND ParamDriver overlaying them — the
 * render-mount membership gate (mirrors `directChannelTargetSet` / `stripTargetSet`).
 * Built in ONE pass, tested O(1) per child in SceneFromDAG (B13).
 */
export function driverTargetSet(nodes: Readonly<Record<string, NodeLike>>): Set<string> {
  const targets = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (!isBoundDriver(node)) continue;
    targets.add(((node.params ?? {}) as DriverParams).target as string);
  }
  return targets;
}

/**
 * The edge-less driver dependency adjacency `{ targetId: [driverId, …] }` — a target
 * DEPENDS ON every driver overlaying it. Fed to `wouldCreateCycle` (state.ts, G6) so a
 * bind that would close a loop (a driver whose compute graph transitively reads back
 * its own target) is rejected before it ships a NaN cook. The wired compute edges are
 * already walked by the cycle guard's input-edge traversal; this adds only the
 * edge-less half the input walk cannot see.
 */
export function driverParamDeps(
  nodes: Readonly<Record<string, NodeLike>>,
): Record<NodeId, NodeId[]> {
  const deps: Record<NodeId, NodeId[]> = {};
  for (const node of Object.values(nodes)) {
    if (!isBoundDriver(node)) continue;
    const target = ((node.params ?? {}) as DriverParams).target as string;
    (deps[target] ??= []).push(node.id);
    // #294 — the spare road has no wired `in` edge for the cycle guard's input walk to
    // follow, so add the driver→sourceNode dependency here. Now target ← driver ←
    // sourceNode is visible: binding a target whose driver reads a spare on a node that
    // (transitively) already reads the target is rejected as a cycle.
    const spare = spareSourceOf(node);
    if (spare) (deps[node.id] ??= []).push(spare.node);
    // #296 — the transform road: driver → controller node, so a bind whose controller
    // (transitively) already reads the target is rejected as a cycle (G6).
    const transform = transformSourceOf(node);
    if (transform) (deps[node.id] ??= []).push(transform.node);
    // #300 F2b — the vec controller road: driver → Point-controller node, so a bind
    // whose controller (transitively) already reads the target is rejected as a cycle.
    const transformVec = transformVecSourceOf(node);
    if (transformVec) (deps[node.id] ??= []).push(transformVec.node);
    // #297 — the stateful road: driver → (wired) Lag → (param-ref) controller. The
    // driver→Lag edge is a real wired edge the guard's input walk sees; the
    // Lag→controller hop is a transform param-ref it can't. Add it so a bind whose
    // Lag reads a controller that (transitively) reads the target is rejected (G6).
    const inRef = node.inputs?.in;
    const inSrcId = (Array.isArray(inRef) ? inRef[0] : inRef) as { node?: string } | undefined;
    const lag = inSrcId?.node ? nodes[inSrcId.node] : undefined;
    const lagXf = lag ? transformSourceOf(lag) : null;
    if (lag && lagXf) (deps[lag.id] ??= []).push(lagXf.node);
  }
  return deps;
}

/**
 * Every {@link KeyframeChannelValue} produced by a ParamDriver bound to `targetId`,
 * built by EVALUATING each driver (its `in` input resolved through the compute graph).
 * Consumed by both fold seams. An unevaluable driver (bad wiring, missing node) is
 * skipped — a lone bad driver falls back to base, never crashes the resolve.
 */
export function driverChannelValuesForTarget(
  state: DagState,
  targetId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): KeyframeChannelValue[] {
  const out: KeyframeChannelValue[] = [];
  for (const node of driverNodesForTarget(state.nodes, targetId)) {
    try {
      const transformVec = transformVecSourceOf(node);
      if (transformVec) {
        // #300 F2b — the VEC controller road ("Point controller"): read the controller's
        // WHOLE evaluated POSITION as a Vec3 (so a gizmo-dragged / animated controller
        // drives correctly) and fold it as a vec3 channel — the SAME fold a position
        // keyframe rides, so it composes byte-identically with the wired inVec road.
        const value = readTransformPositionAt(state, transformVec.node, ctx, cache);
        out.push(makeParamDriverVec3ChannelValue(node.params as ParamDriverParams, value));
        continue;
      }
      const transform = transformSourceOf(node);
      if (transform) {
        // #296 — the Transform Channel road: read the EVALUATED transform of the
        // controller (a Null) via the SHARED reader (so an animated / auto-keyed
        // controller drives correctly), pick the channel, optionally remap through the
        // range, and build through the SAME builder → folds byte-identically to the
        // wired/spare roads. A null resolve (controller not rendered) reads 0.
        const value = readTransformChannelAt(state, transform, ctx, cache);
        out.push(makeParamDriverChannelValue(node.params as ParamDriverParams, value));
        continue;
      }
      const spare = spareSourceOf(node);
      if (spare) {
        // The `ch()` road — the value is a promoted spare on another node, invisible to
        // the pure evaluator. Read it here (the resolver seam has state) and build the
        // channel value through the SAME builder the wired road uses. A non-numeric /
        // missing spare reads 0 (parity with the wired unconnected-input default).
        const raw = readBaseParam(state.nodes[spare.node] as Node | undefined, spare.key);
        const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        out.push(makeParamDriverChannelValue(node.params as ParamDriverParams, value));
      } else {
        // #297 (Epic 2) — a STATEFUL source wired to `in` (a Lag/Spring node) can't be
        // folded as a point-in-time constant: its value depends on the past. Hand off
        // to the replay seam, which returns a channel value whose `sample(seconds)`
        // re-integrates the recurrence from the seed. Both H40 roads call that same
        // `sample`, so render == read under scrub.
        const stateful = statefulSourceOf(node, state);
        if (stateful) {
          out.push(
            makeStatefulDriverChannelValue(
              state,
              node.params as ParamDriverParams,
              stateful,
              cache,
            ),
          );
        } else {
          out.push(evaluate(state, node.id, { cache, ctx }).value as KeyframeChannelValue);
        }
      }
    } catch {
      // Unevaluable driver (e.g. an input cycle the guard didn't stop) → skip it.
    }
  }
  return out;
}
