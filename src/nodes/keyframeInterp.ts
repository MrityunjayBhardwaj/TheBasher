// keyframeInterp — the ONE shared keyframe sampling core for scalar + vec3
// channels (UX-BACKLOG #11, curve-editor foundation).
//
// WHY THIS EXISTS
// ===============
// Until now KeyframeChannelNumber / KeyframeChannelVec3 each carried their own
// `interp()` (linear lerp / smoothstep) and IGNORED the `inHandle`/`outHandle`
// slots the schema already stored — so a "curve editor" had no curve to edit.
// reze-studio's marquee is a per-channel cubic-Bézier curve editor whose handles
// actually bend the motion. This module wires that: when a segment's bounding
// keyframes carry explicit handles it evaluates a true cubic Bézier; otherwise it
// runs the EXACT legacy path so saved animations render byte-identically.
//
// RENDER PARITY (the invariant this module must not break — V49)
// ==============================================================
// A keyframe authored before the curve editor has NO handles. For such a
// segment we take the legacy branch verbatim: `value = a + (b-a)·f(u)` where
// `f = smoothstep` for a 'cubic' destination key and `f = u` for 'linear' (the
// segment's easing is the DESTINATION key's `easing`, matching the pre-#11 code).
// This is not just "close" — flat Bézier handles at ±span/3 reproduce smoothstep
// EXACTLY (proof: equally-spaced X control points make Bézier-X linear in the
// parameter s, so s=u, and the Y polynomial collapses to a + (b-a)·s²(3-2s) =
// a + (b-a)·smoothstep(u)). So routing an unedited key through the Bézier path
// would also be correct; we keep the legacy branch anyway to guarantee
// bit-for-bit parity with zero floating-point drift from the x→s solve.
//
// REF: UX-BACKLOG #11; KeyframeChannelNumber.ts / KeyframeChannelVec3.ts (the
//      callers); vyapti V49.

import type { Vec3 } from './types';

export type Easing = 'linear' | 'cubic';

/** A Bézier handle stored as an OFFSET (time, value) from its keyframe. */
export interface ScalarHandle {
  readonly time: number;
  readonly value: number;
}
export interface Vec3Handle {
  readonly time: number;
  readonly value: Vec3;
}

export interface ScalarKey {
  readonly time: number;
  readonly value: number;
  readonly easing: Easing;
  readonly inHandle?: ScalarHandle;
  readonly outHandle?: ScalarHandle;
}
export interface Vec3Key {
  readonly time: number;
  readonly value: Vec3;
  readonly easing: Easing;
  readonly inHandle?: Vec3Handle;
  readonly outHandle?: Vec3Handle;
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

/** Legacy scalar interpolation — kept bit-identical to the pre-#11 `interp`. */
function legacy(aValue: number, bValue: number, u: number, easing: Easing): number {
  const t = easing === 'cubic' ? smoothstep(u) : u;
  return aValue + (bValue - aValue) * t;
}

/** Evaluate a 1-D cubic Bézier at parameter s∈[0,1]. */
function bezierAt(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const o = 1 - s;
  return o * o * o * p0 + 3 * o * o * s * p1 + 3 * o * s * s * p2 + s * s * s * p3;
}

/**
 * Solve `bezierX(s) = x` for s∈[0,1], assuming X is monotonic across the segment
 * (the curve editor clamps handle time so this holds). Bisection — 30 iterations
 * gives ≈1e-9 precision in s, stable with no derivative blow-ups.
 */
function solveParamForX(p0x: number, p1x: number, p2x: number, p3x: number, x: number): number {
  let lo = 0;
  let hi = 1;
  // Guard the (degenerate) non-increasing case so we never loop on bad data.
  if (p3x <= p0x) return 0;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (bezierAt(p0x, p1x, p2x, p3x, mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Auto-tangent value offset for a side with no explicit handle, from its easing:
 *  'cubic' → flat (0, reproduces smoothstep); 'linear' → along the chord (±Δ/3,
 *  keeps the segment straight). Only reached when EXACTLY one side is edited. */
function autoValueOffset(easing: Easing, delta: number): number {
  return easing === 'cubic' ? 0 : delta / 3;
}

/** Interpolate ONE scalar segment a→b at absolute time t. */
function segmentScalar(a: ScalarKey, b: ScalarKey, t: number): number {
  const span = b.time - a.time;
  if (span <= 0) return a.value;
  const u = (t - a.time) / span;
  // Render parity: untouched segment → legacy easing path, verbatim.
  if (!a.outHandle && !b.inHandle) return legacy(a.value, b.value, u, b.easing);
  // Bézier: explicit handle where present, auto-tangent where absent.
  const ohTime = a.outHandle ? a.outHandle.time : span / 3;
  const ihTime = b.inHandle ? b.inHandle.time : -span / 3;
  const ohVal = a.outHandle ? a.outHandle.value : autoValueOffset(a.easing, b.value - a.value);
  const ihVal = b.inHandle ? b.inHandle.value : autoValueOffset(b.easing, b.value - a.value);
  const s = solveParamForX(a.time, a.time + ohTime, b.time + ihTime, b.time, t);
  return bezierAt(a.value, a.value + ohVal, b.value + ihVal, b.value, s);
}

/** Sample a sorted scalar keyframe list at time t (clamp ends, interpolate mid). */
export function sampleScalarKeyframes(keys: readonly ScalarKey[], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].time && t <= keys[i + 1].time) return segmentScalar(keys[i], keys[i + 1], t);
  }
  return last.value;
}

/** Interpolate ONE vec3 segment a→b at absolute time t. The TIME handles are
 *  shared across components (one BezierHandle<Vec3>), so the x→s solve is done
 *  ONCE; only the per-component Y control points differ. */
function segmentVec3(a: Vec3Key, b: Vec3Key, t: number): Vec3 {
  const span = b.time - a.time;
  if (span <= 0) return a.value;
  if (!a.outHandle && !b.inHandle) {
    const u = (t - a.time) / span;
    const f = b.easing === 'cubic' ? smoothstep(u) : u;
    return [
      a.value[0] + (b.value[0] - a.value[0]) * f,
      a.value[1] + (b.value[1] - a.value[1]) * f,
      a.value[2] + (b.value[2] - a.value[2]) * f,
    ];
  }
  const ohTime = a.outHandle ? a.outHandle.time : span / 3;
  const ihTime = b.inHandle ? b.inHandle.time : -span / 3;
  const s = solveParamForX(a.time, a.time + ohTime, b.time + ihTime, b.time, t);
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const delta = b.value[i] - a.value[i];
    const ohV = a.outHandle ? a.outHandle.value[i] : autoValueOffset(a.easing, delta);
    const ihV = b.inHandle ? b.inHandle.value[i] : autoValueOffset(b.easing, delta);
    out[i] = bezierAt(a.value[i], a.value[i] + ohV, b.value[i] + ihV, b.value[i], s);
  }
  return out;
}

/** Sample a sorted vec3 keyframe list at time t (clamp ends, interpolate mid). */
export function sampleVec3Keyframes(keys: readonly Vec3Key[], t: number): Vec3 {
  if (keys.length === 0) return [0, 0, 0];
  if (t <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].time && t <= keys[i + 1].time) return segmentVec3(keys[i], keys[i + 1], t);
  }
  return last.value;
}
