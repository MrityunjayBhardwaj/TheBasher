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

import type { Vec2, Vec3 } from './types';

export type Easing = 'linear' | 'cubic';

// D1 (#269, vyapti V88 D1) — per-channel EXTRAPOLATION rule for times OUTSIDE the
// authored keyframe domain [firstKey.time, lastKey.time], applied INDEPENDENTLY on
// the left (before the first key) and right (after the last key) side. This is the
// "extend condition" from Houdini's CHOP model (GROUND_TRUTH_HOUDINI_OPERATORS.md
// §3 D1). It is JUST part of the sample function — one place, every caller (3D
// render, read-side gizmo/inspector, compositor) since all sample via ch.sample().
//
//   - hold          clamp to the boundary value — the HISTORIC behaviour, and the
//                   DEFAULT on both sides → byte-identical to the pre-#269 clamp
//                   for every existing animation (render parity, V49).
//   - cycle         repeat the authored range verbatim (value teleports at the
//                   seam unless firstValue == lastValue).
//   - cycle-offset  repeat, accumulating (lastValue − firstValue) each period → a
//                   SEAMLESS loop that keeps travelling (Houdini "cycle w/ offset").
//   - mirror        ping-pong: reflect the range each period (seamless, no travel).
//   - slope         linear extrapolation along the boundary segment's tangent.
export type ChannelExtend = 'hold' | 'cycle' | 'cycle-offset' | 'mirror' | 'slope';

/** The authoring order (also the inspector-dropdown / e2e enumeration order). */
export const CHANNEL_EXTEND_RULES: readonly ChannelExtend[] = [
  'hold',
  'cycle',
  'cycle-offset',
  'mirror',
  'slope',
];

/** A Bézier handle stored as an OFFSET (time, value) from its keyframe. */
export interface ScalarHandle {
  readonly time: number;
  readonly value: number;
}
export interface Vec2Handle {
  readonly time: number;
  readonly value: Vec2;
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
export interface Vec2Key {
  readonly time: number;
  readonly value: Vec2;
  readonly easing: Easing;
  readonly inHandle?: Vec2Handle;
  readonly outHandle?: Vec2Handle;
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

/** Interpolate ONE vec2 segment a→b at absolute time t. The 2-component sibling of
 *  {@link segmentVec3} — one shared x→s solve, per-component Y control points. */
function segmentVec2(a: Vec2Key, b: Vec2Key, t: number): Vec2 {
  const span = b.time - a.time;
  if (span <= 0) return a.value;
  if (!a.outHandle && !b.inHandle) {
    const u = (t - a.time) / span;
    const f = b.easing === 'cubic' ? smoothstep(u) : u;
    return [a.value[0] + (b.value[0] - a.value[0]) * f, a.value[1] + (b.value[1] - a.value[1]) * f];
  }
  const ohTime = a.outHandle ? a.outHandle.time : span / 3;
  const ihTime = b.inHandle ? b.inHandle.time : -span / 3;
  const s = solveParamForX(a.time, a.time + ohTime, b.time + ihTime, b.time, t);
  const out: [number, number] = [0, 0];
  for (let i = 0; i < 2; i++) {
    const delta = b.value[i] - a.value[i];
    const ohV = a.outHandle ? a.outHandle.value[i] : autoValueOffset(a.easing, delta);
    const ihV = b.inHandle ? b.inHandle.value[i] : autoValueOffset(b.easing, delta);
    out[i] = bezierAt(a.value[i], a.value[i] + ohV, b.value[i] + ihV, b.value[i], s);
  }
  return out;
}

/** A discrete (step) keyframe — a value held from its time until the next key.
 *  Used by the text / image channels (prompt travel + reference-image triggers,
 *  COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.4): no interpolation, a value snaps to
 *  the latest key at/before `t`. */
export interface StepKey<T> {
  readonly time: number;
  readonly value: T;
}

/** Sample a sorted discrete keyframe list at time t: the value of the latest key
 *  with `time <= t` (clamp to the first key before its time). `fallback` is
 *  returned for an empty list. No interpolation — this is the step/hold model. */
export function sampleStepKeyframes<T>(keys: readonly StepKey<T>[], t: number, fallback: T): T {
  if (keys.length === 0) return fallback;
  if (t < keys[0].time) return keys[0].value;
  let value = keys[0].value;
  for (const k of keys) {
    if (k.time <= t) value = k.value;
    else break;
  }
  return value;
}

/** Sample a sorted vec2 keyframe list at time t (clamp ends, interpolate mid). */
export function sampleVec2Keyframes(keys: readonly Vec2Key[], t: number): Vec2 {
  if (keys.length === 0) return [0, 0];
  if (t <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].time && t <= keys[i + 1].time) return segmentVec2(keys[i], keys[i + 1], t);
  }
  return last.value;
}

// ── D1 extend / extrapolation (#269, V88 D1) ────────────────────────────────
// The extend rule is TYPE-AGNOSTIC in its TIME mapping (planExtend) and only
// type-specific in the value arithmetic (per-component offset add / slope scale).
// So planExtend is computed ONCE from the domain + rule, and each typed sampler
// applies the plan. The in-range path DELEGATES to the existing `sample*Keyframes`
// verbatim, so a hold/hold channel is byte-identical to the pre-#269 clamp.

/** The plan for sampling ONE out-of-domain time (computed by {@link planExtend}
 *  from the domain + rule alone). `offsetPeriods` is the signed period count for
 *  cycle-offset (0 for cycle/mirror/others → no travel). `dt` on a slope plan is
 *  the signed distance past the boundary (t − start before, t − end after). */
type ExtendPlan =
  | { kind: 'in' }
  | { kind: 'hold'; at: 'first' | 'last' }
  | { kind: 'sample'; t: number; offsetPeriods: number }
  | { kind: 'slope'; at: 'first' | 'last'; dt: number };

/** Pure, type-agnostic: map a time to an {@link ExtendPlan} given the authored
 *  domain [start,end] and the per-side rules. A degenerate span (≤0 — a single
 *  key or coincident endpoints) collapses every rule to hold: there is no range
 *  to cycle/mirror/slope over. Float error can push the mapped time a hair past
 *  the boundary; the `sample*Keyframes` clamp is the safety net. */
function planExtend(
  start: number,
  end: number,
  t: number,
  before: ChannelExtend,
  after: ChannelExtend,
  cyclesBefore = 0,
  cyclesAfter = 0,
): ExtendPlan {
  if (t >= start && t <= end) return { kind: 'in' };
  const isBefore = t < start;
  const at: 'first' | 'last' = isBefore ? 'first' : 'last';
  const rule = isBefore ? before : after;
  // Cycle COUNT (#270 item, Blender FModifierCycles.count): the number of extra
  // repetitions this side plays before it FREEZES at the last extrapolated value.
  // 0 = infinite (the pre-count behaviour). Counted in `span` periods, symmetric
  // with `n` below. Meaningless for hold (no repeat).
  const count = isBefore ? cyclesBefore : cyclesAfter;
  const span = end - start;
  if (span <= 0 || rule === 'hold') return { kind: 'hold', at };
  if (rule === 'slope') {
    // Linear extrapolate for `count` periods, then hold the slope's reached value.
    let dt = isBefore ? t - start : t - end;
    if (count > 0) {
      const maxDt = count * span;
      dt = isBefore ? Math.max(dt, -maxDt) : Math.min(dt, maxDt);
    }
    return { kind: 'slope', at, dt };
  }
  if (rule === 'mirror') {
    // Mirror is continuous at every seam, so clamping the time into the allowed
    // window freezes it at a reflection point with no jump.
    let tt = t;
    if (count > 0)
      tt = isBefore ? Math.max(t, start - count * span) : Math.min(t, end + count * span);
    const period = 2 * span;
    let phase = (tt - start) % period;
    if (phase < 0) phase += period;
    const mapped = phase <= span ? start + phase : end - (phase - span);
    return { kind: 'sample', t: mapped, offsetPeriods: 0 };
  }
  // cycle / cycle-offset: fold t back into [start,end]; offset accumulates the
  // endpoint delta once per period so the loop travels seamlessly.
  const n = Math.floor((t - start) / span); // <0 before, >0 after
  // Past `count` extra periods, freeze at the boundary of the last allowed one.
  // The freeze value is continuous with the in-cycle value at the transition
  // (offset carries `count` deltas; plain cycle holds the boundary key).
  if (count > 0) {
    if (n > count)
      return { kind: 'sample', t: end, offsetPeriods: rule === 'cycle-offset' ? count : 0 };
    if (n < -count) {
      return { kind: 'sample', t: start, offsetPeriods: rule === 'cycle-offset' ? -count : 0 };
    }
  }
  return {
    kind: 'sample',
    t: t - n * span,
    offsetPeriods: rule === 'cycle-offset' ? n : 0,
  };
}

/** Tangent (value-per-second) of the boundary segment, for slope extrapolation. */
function boundaryTangentScalar(keys: readonly ScalarKey[], at: 'first' | 'last'): number {
  if (keys.length < 2) return 0;
  const a = at === 'first' ? keys[0] : keys[keys.length - 2];
  const b = at === 'first' ? keys[1] : keys[keys.length - 1];
  const dt = b.time - a.time;
  return dt > 0 ? (b.value - a.value) / dt : 0;
}

/** Sample a scalar channel at time `t` with per-side extend rules (#269). */
export function sampleScalarKeyframesExtended(
  keys: readonly ScalarKey[],
  t: number,
  before: ChannelExtend = 'hold',
  after: ChannelExtend = 'hold',
  cyclesBefore = 0,
  cyclesAfter = 0,
): number {
  if (keys.length === 0) return 0;
  const first = keys[0];
  const last = keys[keys.length - 1];
  const plan = planExtend(first.time, last.time, t, before, after, cyclesBefore, cyclesAfter);
  switch (plan.kind) {
    case 'in':
      return sampleScalarKeyframes(keys, t);
    case 'hold':
      return plan.at === 'first' ? first.value : last.value;
    case 'sample': {
      const v = sampleScalarKeyframes(keys, plan.t);
      return plan.offsetPeriods === 0 ? v : v + plan.offsetPeriods * (last.value - first.value);
    }
    case 'slope': {
      const bv = plan.at === 'first' ? first.value : last.value;
      return bv + boundaryTangentScalar(keys, plan.at) * plan.dt;
    }
  }
}

function boundaryTangentVec2(keys: readonly Vec2Key[], at: 'first' | 'last'): Vec2 {
  if (keys.length < 2) return [0, 0];
  const a = at === 'first' ? keys[0] : keys[keys.length - 2];
  const b = at === 'first' ? keys[1] : keys[keys.length - 1];
  const dt = b.time - a.time;
  if (dt <= 0) return [0, 0];
  return [(b.value[0] - a.value[0]) / dt, (b.value[1] - a.value[1]) / dt];
}

/** Sample a vec2 channel at time `t` with per-side extend rules (#269). */
export function sampleVec2KeyframesExtended(
  keys: readonly Vec2Key[],
  t: number,
  before: ChannelExtend = 'hold',
  after: ChannelExtend = 'hold',
  cyclesBefore = 0,
  cyclesAfter = 0,
): Vec2 {
  if (keys.length === 0) return [0, 0];
  const first = keys[0];
  const last = keys[keys.length - 1];
  const plan = planExtend(first.time, last.time, t, before, after, cyclesBefore, cyclesAfter);
  switch (plan.kind) {
    case 'in':
      return sampleVec2Keyframes(keys, t);
    case 'hold':
      return plan.at === 'first' ? first.value : last.value;
    case 'sample': {
      const v = sampleVec2Keyframes(keys, plan.t);
      if (plan.offsetPeriods === 0) return v;
      const k = plan.offsetPeriods;
      return [
        v[0] + k * (last.value[0] - first.value[0]),
        v[1] + k * (last.value[1] - first.value[1]),
      ];
    }
    case 'slope': {
      const bv = plan.at === 'first' ? first.value : last.value;
      const tan = boundaryTangentVec2(keys, plan.at);
      return [bv[0] + tan[0] * plan.dt, bv[1] + tan[1] * plan.dt];
    }
  }
}

function boundaryTangentVec3(keys: readonly Vec3Key[], at: 'first' | 'last'): Vec3 {
  if (keys.length < 2) return [0, 0, 0];
  const a = at === 'first' ? keys[0] : keys[keys.length - 2];
  const b = at === 'first' ? keys[1] : keys[keys.length - 1];
  const dt = b.time - a.time;
  if (dt <= 0) return [0, 0, 0];
  return [
    (b.value[0] - a.value[0]) / dt,
    (b.value[1] - a.value[1]) / dt,
    (b.value[2] - a.value[2]) / dt,
  ];
}

/** Sample a vec3 channel at time `t` with per-side extend rules (#269). */
export function sampleVec3KeyframesExtended(
  keys: readonly Vec3Key[],
  t: number,
  before: ChannelExtend = 'hold',
  after: ChannelExtend = 'hold',
  cyclesBefore = 0,
  cyclesAfter = 0,
): Vec3 {
  if (keys.length === 0) return [0, 0, 0];
  const first = keys[0];
  const last = keys[keys.length - 1];
  const plan = planExtend(first.time, last.time, t, before, after, cyclesBefore, cyclesAfter);
  switch (plan.kind) {
    case 'in':
      return sampleVec3Keyframes(keys, t);
    case 'hold':
      return plan.at === 'first' ? first.value : last.value;
    case 'sample': {
      const v = sampleVec3Keyframes(keys, plan.t);
      if (plan.offsetPeriods === 0) return v;
      const k = plan.offsetPeriods;
      return [
        v[0] + k * (last.value[0] - first.value[0]),
        v[1] + k * (last.value[1] - first.value[1]),
        v[2] + k * (last.value[2] - first.value[2]),
      ];
    }
    case 'slope': {
      const bv = plan.at === 'first' ? first.value : last.value;
      const tan = boundaryTangentVec3(keys, plan.at);
      return [bv[0] + tan[0] * plan.dt, bv[1] + tan[1] * plan.dt, bv[2] + tan[2] * plan.dt];
    }
  }
}
