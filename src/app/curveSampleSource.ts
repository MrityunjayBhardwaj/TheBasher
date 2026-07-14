// curveSampleSource — the WORLD-space sampling seam for the Curve scene object (#321).
// The twin of geometrySampleSource.ts (which answers "where is the ground under this
// point?"); this one answers "where is this path at fraction `u` of its length?".
//
// ─── WHY THE SEAM, AND WHY ARC LENGTH ────────────────────────────────────────────────
//
// Follow-Path (Phase 4) maps a keyframeable `evalTime` onto a position along the curve.
// That mapping MUST be by DISTANCE ALONG THE PATH, not by raw spline parameter `t`.
// With raw `t`, each span gets an equal share of `t` regardless of how long it is, so a
// curve whose control points are unevenly spaced makes the object crawl through the short
// spans and bolt through the long ones — even when `evalTime` is perfectly linear. That
// destroys the whole point of the F-curve editor: you cannot author an ease on top of a
// base motion that isn't constant-speed, because you can't tell your ease from the
// curve's own lurching. Blender evaluates Follow-Path over path length for this reason.
// So the seam exposes `pointAt(u)` where u is a fraction of LENGTH — never `getPoint(t)`.
//
// And the table MUST be built here, in the seam, rather than in the node's `evaluate`:
//
//   1. A curve carries a TRS and may be parented. Under a NON-UNIFORM scale (its own or
//      an ancestor's), local distance is not proportional to world distance — the scale
//      stretches some spans more than others. An arc-length table measured in local space
//      would therefore still lurch in world space, reintroducing the exact defect
//      arc-length parameterization exists to remove. Only a WORLD table is constant-speed.
//   2. World space only exists after composition, via `resolveWorldTransform(state, …)` —
//      and `evaluate` is pure: it receives its own params and nothing else (evaluator.ts),
//      so it cannot see `state`. The read is structurally impossible in the node.
//
// That is the same reason the transform driver, the stateful replay and the Ray sensor all
// resolve in the seam rather than in `evaluate`: cross-object world reads only exist after
// composition. The node bakes the local polyline; the seam measures it in world.
//
// REF: src/nodes/curveMath.ts (the pure local sampler); src/nodes/Curve.ts;
//      src/app/geometrySampleSource.ts (the sibling seam + the BVH-cache precedent);
//      src/app/resolveWorldTransform.ts (the one world resolver — never a parallel walk).

import { Matrix4, Vector3 } from 'three';
import type { EvaluatorCache } from '../core/dag/evaluator';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx } from '../core/dag/types';
import type { CurveValue, Vec3 } from '../nodes/types';
import { resolveWorldTransform } from './resolveWorldTransform';

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A degenerate (zero-length) curve has no direction of travel. Any unit vector is as
 *  arbitrary as any other; +Z keeps downstream orientation math finite instead of NaN. */
const FALLBACK_TANGENT: Vec3 = [0, 0, 1];

/** An arc-length-parameterized view of one curve, in WORLD space. */
export interface CurveSampler {
  /** Total path length, in world units. Zero for a degenerate curve. */
  readonly length: number;
  /** Whether the path loops (u wraps rather than clamps). */
  readonly closed: boolean;
  /** The world point at arc-length fraction `u`. Constant-speed in `u` by construction. */
  pointAt(u: number): Vec3;
  /** The unit direction of travel at `u` (the world polyline's local heading). */
  tangentAt(u: number): Vec3;
}

/**
 * The world polyline + its cumulative arc-length table, cached across frames.
 *
 * Keyed by the identity of the value's `samples` array (a WeakMap — re-authoring the curve
 * yields a NEW samples array from `evaluate`, so the stale table is dropped and GC'd) PLUS
 * the world-matrix hash in a SINGLE slot: a static curve reuses one table forever, while a
 * moving/animated one rebuilds per frame with memory bounded to one table per curve. This
 * is exactly the `bvhCache` shape in geometrySampleSource.ts:136, for the same reason.
 *
 * (Identity-keying works because the evaluator memoizes pure nodes by content hash — a
 * cache hit returns the SAME result object. Without a cache the table simply rebuilds,
 * which is correct, just not free.)
 */
const tableCache = new WeakMap<object, { matrixKey: string; table: WorldTable }>();

interface WorldTable {
  /** World-space polyline points. */
  points: Vec3[];
  /** cumulative[i] = distance along the path from points[0] to points[i]. */
  cumulative: number[];
  length: number;
}

function buildWorldTable(samples: readonly Vec3[], matrix: ArrayLike<number>): WorldTable {
  const m = new Matrix4().fromArray(matrix as number[]);
  const v = new Vector3();
  const points: Vec3[] = samples.map((s) => {
    v.set(s[0], s[1], s[2]).applyMatrix4(m);
    return [v.x, v.y, v.z];
  });

  const cumulative: number[] = new Array(points.length);
  cumulative[0] = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    cumulative[i] = cumulative[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return { points, cumulative, length: cumulative[points.length - 1] ?? 0 };
}

/** The largest i with cumulative[i] <= target — binary search over the monotone table. */
function spanAt(cumulative: readonly number[], target: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumulative[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The arc-length sampler for a Curve node, or null when `curveId` is not a Curve.
 *
 * Returned as an object (rather than a bare `readCurvePointAt`) so a consumer sampling the
 * same curve many times in a frame — a Follow-Path resolving position AND tangent, a motion
 * trail drawing N ticks — pays for the world table once.
 */
export function curveSamplerFor(
  state: DagState,
  curveId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): CurveSampler | null {
  const node = state.nodes[curveId];
  if (!node || node.type !== 'Curve') return null;

  const value = evaluate(state, curveId, { ctx, cache }).value as CurveValue | undefined;
  const samples = value?.samples;
  if (!samples || samples.length === 0) return null;

  const matrix = resolveWorldTransform(state, curveId, ctx, cache)?.matrix ?? IDENTITY16;
  const matrixKey = Array.prototype.join.call(matrix, ',');

  const key = samples as unknown as object;
  const hit = tableCache.get(key);
  let table: WorldTable;
  if (hit && hit.matrixKey === matrixKey) {
    table = hit.table;
  } else {
    table = buildWorldTable(samples as readonly Vec3[], matrix);
    tableCache.set(key, { matrixKey, table });
  }

  const closed = value?.closed === true;

  /** u → a distance along the path. A closed path WRAPS (a Follow-Path past the end loops
   *  round); an open one CLAMPS (it stops at the end rather than teleporting home) — the
   *  same distinction Blender draws with a curve's Cyclic flag. NaN degrades to the start. */
  const distanceFor = (u: number): number => {
    if (!Number.isFinite(u)) return 0;
    const f = closed ? ((u % 1) + 1) % 1 : Math.min(1, Math.max(0, u));
    return f * table.length;
  };

  const pointAt = (u: number): Vec3 => {
    if (table.length === 0) return [...table.points[0]] as Vec3;
    const target = distanceFor(u);
    const i = spanAt(table.cumulative, target);
    const a = table.points[i];
    const b = table.points[i + 1];
    if (!b) return [...a] as Vec3;
    const span = table.cumulative[i + 1] - table.cumulative[i];
    const t = span > 0 ? (target - table.cumulative[i]) / span : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };

  const tangentAt = (u: number): Vec3 => {
    if (table.length === 0) return [...FALLBACK_TANGENT];
    const target = distanceFor(u);
    const i = spanAt(table.cumulative, target);
    // At the very end of an open path there is no forward span — read the one behind.
    const a = table.points[i + 1] ? table.points[i] : table.points[i - 1];
    const b = table.points[i + 1] ?? table.points[i];
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    return len > 0 ? [d[0] / len, d[1] / len, d[2] / len] : [...FALLBACK_TANGENT];
  };

  return { length: table.length, closed, pointAt, tangentAt };
}

/**
 * The world point + unit tangent at arc-length fraction `u` — the one-shot read a
 * relational CHOP performs per frame. Null when `curveId` is not a Curve.
 */
export function readCurveSampleAt(
  state: DagState,
  curveId: string,
  u: number,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): { point: Vec3; tangent: Vec3; length: number } | null {
  const sampler = curveSamplerFor(state, curveId, ctx, cache);
  if (!sampler) return null;
  return { point: sampler.pointAt(u), tangent: sampler.tangentAt(u), length: sampler.length };
}
