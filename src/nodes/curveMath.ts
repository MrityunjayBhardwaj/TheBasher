// curveMath — the pure Catmull-Rom sampler behind the Curve scene object (#321).
//
// Centripetal Catmull-Rom (alpha = 0.5), the same choice three.js's CatmullRomCurve3
// and Blender make. Uniform Catmull-Rom (alpha = 0) cusps and self-intersects when the
// control polygon turns sharply or its points bunch up — visible as a little loop the
// director never authored. Centripetal is provably free of both. Chordal (alpha = 1)
// avoids them too but overshoots wide on uneven spacing.
//
// Catmull-Rom (not Bezier) for v1 because the spline passes THROUGH its control points:
// "drag a point, the path goes there." Bezier tangent handles are a later, additive
// slice — they change how the polyline is GENERATED, never the sampling seam that
// consumes it (curveSampleSource.ts asks only for `samples`).
//
// This module is PURE and LOCAL-space by construction — it is called from the node's
// `evaluate`, which has no `state` and therefore cannot see world transforms. The
// world-space arc-length table lives in the seam. See curveSampleSource.ts for WHY
// that split is load-bearing rather than incidental.

// The canonical scene Vec3 (a READONLY tuple) — not a local alias, so a curve's points
// flow into/out of node params without a cast.
import type { Vec3 } from './types';

const ALPHA = 0.5; // centripetal

/** Coincident (or near-coincident) control points give a zero knot interval, which
 *  would divide by zero in the Barry-Goldman lerps. Floor it: a duplicated point then
 *  behaves as a momentary stop rather than producing NaNs that poison the whole path. */
const MIN_KNOT_SPAN = 1e-6;

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The next knot in the centripetal parameterization. */
function nextKnot(t: number, a: Vec3, b: Vec3): number {
  return t + Math.max(dist(a, b), MIN_KNOT_SPAN) ** ALPHA;
}

/**
 * One Catmull-Rom span from `p1` to `p2`, with `p0`/`p3` as the surrounding tangent
 * neighbours — evaluated by the Barry-Goldman pyramidal formulation (three nested lerps),
 * which handles the NON-uniform knot spacing centripetal parameterization produces.
 * Emits `resolution` points starting AT p1 and stopping just BEFORE p2, so spans
 * concatenate without duplicating the shared joint.
 */
function spanSamples(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, resolution: number): Vec3[] {
  const t0 = 0;
  const t1 = nextKnot(t0, p0, p1);
  const t2 = nextKnot(t1, p1, p2);
  const t3 = nextKnot(t2, p2, p3);

  const out: Vec3[] = [];
  for (let i = 0; i < resolution; i++) {
    const t = t1 + ((t2 - t1) * i) / resolution;
    const a1 = lerp(p0, p1, (t - t0) / (t1 - t0));
    const a2 = lerp(p1, p2, (t - t1) / (t2 - t1));
    const a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
    const b1 = lerp(a1, a2, (t - t0) / (t2 - t0));
    const b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
    out.push(lerp(b1, b2, (t - t1) / (t2 - t1)));
  }
  return out;
}

/** Reflect `b` through `a` — the phantom neighbour that gives an OPEN curve's end span
 *  a tangent. (A closed curve wraps instead and needs no phantom.) */
function reflect(a: Vec3, b: Vec3): Vec3 {
  return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
}

/**
 * The dense local-space polyline through `points`.
 *
 * The returned list is always a SIMPLE (non-wrapping) strip: for a closed curve the
 * first point is repeated as the last, so the closing span is an ordinary segment.
 * Every downstream consumer — the renderer's line strip, and the seam's arc-length
 * table — can then walk it as a flat list with no wrap-around special case.
 *
 * Length: open → (n-1) * resolution + 1;  closed → n * resolution + 1.
 * Fewer than 2 points cannot describe a path; the caller's schema floors it at 2, and
 * we degrade to the points themselves rather than throwing.
 */
export function sampleCurve(points: readonly Vec3[], closed: boolean, resolution: number): Vec3[] {
  const n = points.length;
  if (n < 2) return points.map((p) => [...p] as Vec3);
  const res = Math.max(1, Math.floor(resolution));

  const at = (i: number): Vec3 => points[((i % n) + n) % n];
  const spanCount = closed ? n : n - 1;
  const samples: Vec3[] = [];

  for (let i = 0; i < spanCount; i++) {
    const p1 = points[i];
    const p2 = closed ? at(i + 1) : points[i + 1];
    const p0 = closed ? at(i - 1) : i === 0 ? reflect(p1, p2) : points[i - 1];
    const p3 = closed ? at(i + 2) : i + 2 < n ? points[i + 2] : reflect(p2, p1);
    samples.push(...spanSamples(p0, p1, p2, p3, res));
  }
  // Close the strip: the final joint (the last control point, or the first one again
  // for a closed loop) — the point every span stopped short of.
  samples.push([...(closed ? points[0] : points[n - 1])] as Vec3);
  return samples;
}
