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
import {
  applyChannelModifiers,
  resolveSampleTime,
  type CycleMode,
  type FChannelModifier,
  type FModCycles,
} from './channelModifiers';

// Per-keyframe interpolation TYPE. 'linear' and 'cubic' (=smoothstep) are the
// LEGACY values — untouched, byte-identical to every pre-#272 animation. The rest
// are Blender's F-Curve interpolations (#272): 'constant' (stepped hold) + the
// Penner easing equations. The convention is DESTINATION-key-governs (as it has
// always been for 'cubic'): a key's `easing` describes how the curve ARRIVES at it —
// 'constant' holds the previous value then snaps, 'bounce' arrives with a bounce.
export type Easing =
  | 'linear'
  | 'cubic'
  | 'constant'
  | 'sine'
  | 'quad'
  | 'quart'
  | 'quint'
  | 'expo'
  | 'circ'
  | 'back'
  | 'bounce'
  | 'elastic';

/** The direction an easing EQUATION is applied (#272, Blender's easing type). Only
 *  meaningful for the equation interps (sine…elastic); ignored by linear/cubic/
 *  constant. Default 'inout' (the smoothest, matches the symmetric feel of the
 *  legacy 'cubic'/smoothstep). */
export type EaseDir = 'in' | 'out' | 'inout';

/** The equation interps — those governed by {@link easeFraction} rather than the
 *  legacy linear/smoothstep or the bézier-handle path. 'constant' is here too
 *  (a degenerate "equation" = step). */
const EQUATION_INTERPS: ReadonlySet<string> = new Set([
  'constant',
  'sine',
  'quad',
  'quart',
  'quint',
  'expo',
  'circ',
  'back',
  'bounce',
  'elastic',
]);

/** Authoring order for the interpolation dropdown / e2e enumeration. */
export const KEYFRAME_INTERPS: readonly Easing[] = [
  'constant',
  'linear',
  'cubic',
  'sine',
  'quad',
  'quart',
  'quint',
  'expo',
  'circ',
  'back',
  'bounce',
  'elastic',
];

export const EASE_DIRS: readonly EaseDir[] = ['in', 'out', 'inout'];

// #273 — per-keyframe bézier HANDLE TYPE (Blender F-Curve handles). Only meaningful
// for the bézier interpolation (a 'linear'/'cubic' destination key — NOT the
// equation interps or 'constant', which are distinct interpolation MODES that
// ignore handles, matching Blender). OPTIONAL: undefined = the pre-#273 behaviour
// (stored explicit handle, else the legacy linear/smoothstep) → byte-identical for
// every existing animation. Opt-in only; the default handle feel is never flipped.
//
//   - free          the two handles are independent, taken from the STORED offsets
//                   (this is what a manual handle drag produces — the pre-#273 path).
//   - aligned       stored handles kept colinear; the colinearity is an EDIT-time
//                   constraint, so at sample time 'aligned' == 'free'.
//   - vector        each handle points ⅓ of the way toward its neighbour key →
//                   straight-line-ish segments that auto-update (segment-LOCAL).
//   - auto          smooth C1 tangent computed from BOTH neighbours (Catmull-like);
//                   may overshoot past a key's value.
//   - auto-clamped  auto + the overshoot clamp: flat (horizontal) at a local
//                   extremum, else clamped to the neighbour value. Blender's DEFAULT.
export type HandleType = 'free' | 'aligned' | 'vector' | 'auto' | 'auto-clamped';

/** Authoring order for the handle-type dropdown / e2e enumeration (Blender's order,
 *  auto-clamped first as it is the Blender default). */
export const KEYFRAME_HANDLE_TYPES: readonly HandleType[] = [
  'auto-clamped',
  'auto',
  'vector',
  'aligned',
  'free',
];

/** The handle types whose handles are COMPUTED from neighbours (vs. taken from the
 *  stored offsets). free/aligned use stored handles; these three synthesize. */
const COMPUTED_HANDLE_TYPES: ReadonlySet<string> = new Set(['vector', 'auto', 'auto-clamped']);

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
//
// #275 — the RESOLVED internal rule fed to `planExtend`. The STORED model splits
// this (Blender-faithful): hold/slope are the channel's per-side EXTRAPOLATION
// property ({@link ChannelExtrapolate}); cycle/cycle-offset/mirror moved to a Cycles
// F-Modifier (channelModifiers.ts). {@link resolveExtend} maps the stored model back
// onto this 5-value rule so `planExtend` and every extend test stay byte-identical.
export type ChannelExtend = 'hold' | 'cycle' | 'cycle-offset' | 'mirror' | 'slope';

/** The authoring order for the internal rule (also used by extend unit tests). */
export const CHANNEL_EXTEND_RULES: readonly ChannelExtend[] = [
  'hold',
  'cycle',
  'cycle-offset',
  'mirror',
  'slope',
];

/** #275 — the per-side EXTRAPOLATION a channel STORES: how the curve behaves past
 *  its own ends. `hold` = clamp (Blender CONSTANT, the byte-identical default);
 *  `slope` = linear along the boundary tangent (Blender LINEAR). The cycling rules
 *  are no longer here — they are a Cycles F-Modifier. Basher keeps this PER-SIDE (a
 *  deliberate superset of Blender's single-value extrapolation). */
export type ChannelExtrapolate = 'hold' | 'slope';

/** Authoring order for the extrapolation dropdown / e2e enumeration. */
export const EXTRAPOLATE_RULES: readonly ChannelExtrapolate[] = ['hold', 'slope'];

/** Maps a Cycles-modifier per-side mode onto the internal {@link ChannelExtend}
 *  rule that `planExtend` consumes. 'none' has no entry (extrapolation applies). */
const CYCLE_MODE_TO_RULE: Record<Exclude<CycleMode, 'none'>, ChannelExtend> = {
  repeat: 'cycle',
  'repeat-offset': 'cycle-offset',
  'repeat-mirror': 'mirror',
};

/** #275 — resolve a channel's STORED extend model (per-side hold/slope extrapolation
 *  + an optional Cycles F-Modifier in its stack) into the internal 5-value rule +
 *  counts that {@link sampleScalarKeyframesExtended} & friends already consume. A
 *  non-muted Cycles modifier's per-side mode (when not 'none') OVERRIDES that side's
 *  extrapolation (Blender: Cycles is a time modifier that supersedes extrapolation).
 *  This is the ONE place the stored model becomes the engine's resolved form, so
 *  `planExtend` — and every byte-identity extend test — stay untouched. */
export function resolveExtend(
  extendBefore: ChannelExtrapolate = 'hold',
  extendAfter: ChannelExtrapolate = 'hold',
  modifiers?: readonly FChannelModifier[],
): { before: ChannelExtend; after: ChannelExtend; cyclesBefore: number; cyclesAfter: number } {
  const cyc = modifiers?.find((m): m is FModCycles => m.type === 'cycles' && !m.muted);
  const beforeCyclic = cyc && cyc.beforeMode !== 'none';
  const afterCyclic = cyc && cyc.afterMode !== 'none';
  return {
    before: beforeCyclic
      ? CYCLE_MODE_TO_RULE[cyc.beforeMode as Exclude<CycleMode, 'none'>]
      : extendBefore,
    after: afterCyclic
      ? CYCLE_MODE_TO_RULE[cyc.afterMode as Exclude<CycleMode, 'none'>]
      : extendAfter,
    cyclesBefore: beforeCyclic ? cyc.beforeCycles : 0,
    cyclesAfter: afterCyclic ? cyc.afterCycles : 0,
  };
}

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
  readonly ease?: EaseDir;
  readonly handleType?: HandleType;
  readonly inHandle?: ScalarHandle;
  readonly outHandle?: ScalarHandle;
}
export interface Vec2Key {
  readonly time: number;
  readonly value: Vec2;
  readonly easing: Easing;
  readonly ease?: EaseDir;
  readonly handleType?: HandleType;
  readonly inHandle?: Vec2Handle;
  readonly outHandle?: Vec2Handle;
}
export interface Vec3Key {
  readonly time: number;
  readonly value: Vec3;
  readonly easing: Easing;
  readonly ease?: EaseDir;
  readonly handleType?: HandleType;
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

// ── Easing equations (#272, Blender F-Curve interpolations) ─────────────────
// Standard Penner easings, normalised so ease(0)=0 and ease(1)=1. Each family has
// an 'in' shape; 'out' is the point-reflection ease_out(u)=1−in(1−u); 'inout'
// stitches a half-scaled in then out. These are pure functions of u∈[0,1].

const c1 = 1.70158; // back overshoot
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3; // elastic (in/out)
const c5 = (2 * Math.PI) / 4.5; // elastic (inout)

/** bounce 'out' (the canonical piecewise); the others derive from it. */
function bounceOut(u: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (u < 1 / d1) return n1 * u * u;
  if (u < 2 / d1) return n1 * (u -= 1.5 / d1) * u + 0.75;
  if (u < 2.5 / d1) return n1 * (u -= 2.25 / d1) * u + 0.9375;
  return n1 * (u -= 2.625 / d1) * u + 0.984375;
}

/** The 'in' shape for each equation family (u∈[0,1] → eased fraction). */
function easeInShape(interp: Easing, u: number): number {
  switch (interp) {
    case 'sine':
      return 1 - Math.cos((u * Math.PI) / 2);
    case 'quad':
      return u * u;
    case 'quart':
      return u * u * u * u;
    case 'quint':
      return u * u * u * u * u;
    case 'expo':
      return u === 0 ? 0 : Math.pow(2, 10 * u - 10);
    case 'circ':
      return 1 - Math.sqrt(1 - u * u);
    case 'back':
      return c3 * u * u * u - c1 * u * u;
    case 'bounce':
      return 1 - bounceOut(1 - u);
    case 'elastic':
      return u === 0 || u === 1 ? u : -Math.pow(2, 10 * u - 10) * Math.sin((u * 10 - 10.75) * c4);
    default:
      return u; // unreachable for equation interps
  }
}

/** Eased fraction f∈[0,1] for a keyframe interpolation + direction. 'constant' is
 *  a step (holds the source value until the destination key, then snaps).
 *  in → the family's 'in' shape; out → 1−in(1−u); inout → half-in then half-out. */
function easeFraction(interp: Easing, dir: EaseDir, u: number): number {
  if (interp === 'constant') return u >= 1 ? 1 : 0;
  // Special-cased 'inout' families that don't cleanly derive from the 'in' shape.
  if (dir === 'inout') {
    switch (interp) {
      case 'sine':
        return -(Math.cos(Math.PI * u) - 1) / 2;
      case 'expo':
        return u === 0 || u === 1
          ? u
          : u < 0.5
            ? Math.pow(2, 20 * u - 10) / 2
            : (2 - Math.pow(2, -20 * u + 10)) / 2;
      case 'circ':
        return u < 0.5
          ? (1 - Math.sqrt(1 - Math.pow(2 * u, 2))) / 2
          : (Math.sqrt(1 - Math.pow(-2 * u + 2, 2)) + 1) / 2;
      case 'back':
        return u < 0.5
          ? (Math.pow(2 * u, 2) * ((c2 + 1) * 2 * u - c2)) / 2
          : (Math.pow(2 * u - 2, 2) * ((c2 + 1) * (u * 2 - 2) + c2) + 2) / 2;
      case 'elastic':
        return u === 0 || u === 1
          ? u
          : u < 0.5
            ? -(Math.pow(2, 20 * u - 10) * Math.sin((20 * u - 11.125) * c5)) / 2
            : (Math.pow(2, -20 * u + 10) * Math.sin((20 * u - 11.125) * c5)) / 2 + 1;
      case 'bounce':
        return u < 0.5 ? (1 - bounceOut(1 - 2 * u)) / 2 : (1 + bounceOut(2 * u - 1)) / 2;
      default:
        // quad/quart/quint: symmetric power stitch.
        return u < 0.5
          ? Math.pow(2, powExp(interp) - 1) * Math.pow(u, powExp(interp))
          : 1 - Math.pow(-2 * u + 2, powExp(interp)) / 2;
    }
  }
  if (dir === 'out') return 1 - easeInShape(interp, 1 - u);
  return easeInShape(interp, u); // 'in'
}

/** Power exponent for the polynomial families (quad=2, quart=4, quint=5). */
function powExp(interp: Easing): number {
  return interp === 'quad' ? 2 : interp === 'quart' ? 4 : 5;
}

/** Apply a keyframe's interpolation between two scalar endpoints (equation path). */
function easedValue(
  aValue: number,
  bValue: number,
  u: number,
  key: { easing: Easing; ease?: EaseDir },
): number {
  return aValue + (bValue - aValue) * easeFraction(key.easing, key.ease ?? 'inout', u);
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

// ── #273 handle types — computed bézier handles (Blender F-Curve parity) ─────
// A resolved handle is a (time, value) OFFSET from its key, or undefined when the
// side has no handle (the segment falls back to the easing auto-tangent). Only the
// SCALAR path computes these; vec2/vec3 handle-typed segments sample per-component
// through the scalar path, because each axis is its own F-curve with its own auto
// tangent (Blender). REF: fcurve.cc calchandle_fcurve_intern + correct_bezpart.

interface ResolvedHandle {
  time: number;
  value: number;
}
type TimeValue = { readonly time: number; readonly value: number };

/** Whether ANY key carries a handleType — the opt-in switch that routes a channel
 *  off the byte-identical fast path onto the handle-type-aware path. */
function anyHandleType(keys: ReadonlyArray<{ readonly handleType?: HandleType }>): boolean {
  for (const k of keys) if (k.handleType !== undefined) return true;
  return false;
}

/** A vector handle points ⅓ of the way toward its side's neighbour key. At a
 *  boundary (no neighbour on that side) there is nothing to point at → undefined,
 *  so the segment uses the easing auto-tangent (flat for 'cubic'). */
function vectorHandleScalar(
  k: TimeValue,
  side: 'in' | 'out',
  prev: TimeValue | undefined,
  next: TimeValue | undefined,
): ResolvedHandle | undefined {
  const ref = side === 'out' ? next : prev;
  if (!ref) return undefined;
  return { time: (ref.time - k.time) / 3, value: (ref.value - k.value) / 3 };
}

/** Clamp an auto-clamped handle's ABSOLUTE value against ONE neighbour (Blender's
 *  overshoot guard): at a local extremum (both neighbours on the same y-side) flatten
 *  to the key value; else clamp so the handle does not pass the neighbour. Returns
 *  the clamped VALUE OFFSET. `nb` is the neighbour on this handle's side (out→next,
 *  in→prev); `other` is the opposite neighbour (only used for the extremum test). */
function clampAutoOffset(offV: number, kVal: number, nb: number, other: number): number {
  const dNb = nb - kVal;
  const dOther = other - kVal;
  if ((dNb <= 0 && dOther <= 0) || (dNb >= 0 && dOther >= 0)) return 0; // extremum → flat
  let absH = kVal + offV;
  if (dNb <= 0) {
    if (nb > absH) absH = nb; // neighbour below → don't undershoot past it
  } else if (nb < absH) {
    absH = nb; // neighbour above → don't overshoot past it
  }
  return absH - kVal;
}

/** Blender auto tangent (calchandle_fcurve_intern): a single smooth direction
 *  `tvec = dvec_b/len_b + dvec_a/len_a` scaled per side by len/·2.5614. Boundaries
 *  reflect a virtual neighbour (2·k − other). auto-clamped adds {@link clampAutoOffset}. */
function autoHandleScalar(
  k: TimeValue,
  side: 'in' | 'out',
  prev: TimeValue | undefined,
  next: TimeValue | undefined,
  clamped: boolean,
): ResolvedHandle {
  const p1: TimeValue | undefined =
    prev ?? (next ? { time: 2 * k.time - next.time, value: 2 * k.value - next.value } : undefined);
  const p3: TimeValue | undefined =
    next ?? (prev ? { time: 2 * k.time - prev.time, value: 2 * k.value - prev.value } : undefined);
  if (!p1 || !p3) return { time: 0, value: 0 }; // isolated key — no tangent
  const dax = k.time - p1.time;
  const day = k.value - p1.value;
  const dbx = p3.time - k.time;
  const dby = p3.value - k.value;
  let lenA = Math.hypot(dax, day);
  let lenB = Math.hypot(dbx, dby);
  if (lenA === 0) lenA = 1;
  if (lenB === 0) lenB = 1;
  const tvx = dbx / lenB + dax / lenA;
  const tvy = dby / lenB + day / lenA;
  const len = Math.hypot(tvx, tvy) * 2.5614;
  if (len === 0) return { time: 0, value: 0 };
  if (side === 'out') {
    const l = lenB / len;
    let offV = tvy * l;
    // Clamp only when BOTH real neighbours exist (Blender's guard).
    if (clamped && prev && next) offV = clampAutoOffset(offV, k.value, next.value, prev.value);
    return { time: tvx * l, value: offV };
  }
  const l = lenA / len;
  let offV = -tvy * l;
  if (clamped && prev && next) offV = clampAutoOffset(offV, k.value, prev.value, next.value);
  return { time: -tvx * l, value: offV };
}

/** Resolve ONE side's effective handle for key `i`, honouring its handleType.
 *  undefined / free / aligned → the STORED offset (aligned's colinearity is an
 *  edit-time constraint); vector/auto/auto-clamped → computed from neighbours.
 *  Exported so the curve editor DISPLAYS the same handle it plays (H40). */
export function resolveScalarHandle(
  keys: readonly ScalarKey[],
  i: number,
  side: 'in' | 'out',
): ResolvedHandle | undefined {
  const k = keys[i];
  const ht = k.handleType;
  const stored = side === 'out' ? k.outHandle : k.inHandle;
  if (ht === undefined || !COMPUTED_HANDLE_TYPES.has(ht)) return stored;
  const prev = i > 0 ? keys[i - 1] : undefined;
  const next = i < keys.length - 1 ? keys[i + 1] : undefined;
  if (ht === 'vector') return vectorHandleScalar(k, side, prev, next);
  return autoHandleScalar(k, side, prev, next, ht === 'auto-clamped');
}

/** Blender's correct_bezpart: if the two inner control points overshoot the segment
 *  in TIME (would make the curve non-functional), shrink BOTH handles uniformly about
 *  their endpoints so X stays monotonic for the x→s solve. `cp` is the ABSOLUTE
 *  control tuple [h1x, h1y, h2x, h2y]; returns the corrected tuple. */
function correctBezpart(
  cp: [number, number, number, number],
  p0x: number,
  p0y: number,
  p3x: number,
  p3y: number,
): [number, number, number, number] {
  const len1 = Math.abs(p0x - cp[0]);
  const len2 = Math.abs(p3x - cp[2]);
  const total = len1 + len2;
  const span = p3x - p0x;
  if (total <= span || total === 0) return cp;
  const fac = span / total;
  return [
    p0x - (p0x - cp[0]) * fac,
    p0y - (p0y - cp[1]) * fac,
    p3x - (p3x - cp[2]) * fac,
    p3y - (p3y - cp[3]) * fac,
  ];
}

/** Interpolate ONE scalar segment a→b at absolute time t. */
function segmentScalar(a: ScalarKey, b: ScalarKey, t: number): number {
  const span = b.time - a.time;
  if (span <= 0) return a.value;
  const u = (t - a.time) / span;
  // #272 — an equation interpolation (constant / Penner) takes the equation path,
  // ignoring bézier handles (Blender's equation interps aren't handle-driven).
  if (EQUATION_INTERPS.has(b.easing)) return easedValue(a.value, b.value, u, b);
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

/** Interpolate ONE scalar segment (index i→i+1) with handle TYPES resolved from
 *  neighbours (#273). Reached only when a segment endpoint carries a handleType;
 *  otherwise {@link segmentScalar} runs verbatim (byte-identical fast path). */
function segmentScalarTyped(keys: readonly ScalarKey[], i: number, t: number): number {
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.time - a.time;
  if (span <= 0) return a.value;
  const u = (t - a.time) / span;
  // An equation interpolation / 'constant' is a distinct interpolation MODE that
  // ignores handles (Blender) — handle type is irrelevant here.
  if (EQUATION_INTERPS.has(b.easing)) return easedValue(a.value, b.value, u, b);
  const aOut = resolveScalarHandle(keys, i, 'out');
  const bIn = resolveScalarHandle(keys, i + 1, 'in');
  // Neither side has a handle → legacy linear/smoothstep (as the fast path would).
  if (!aOut && !bIn) return legacy(a.value, b.value, u, b.easing);
  const ohTime = aOut ? aOut.time : span / 3;
  const ihTime = bIn ? bIn.time : -span / 3;
  const ohVal = aOut ? aOut.value : autoValueOffset(a.easing, b.value - a.value);
  const ihVal = bIn ? bIn.value : autoValueOffset(b.easing, b.value - a.value);
  const cp = correctBezpart(
    [a.time + ohTime, a.value + ohVal, b.time + ihTime, b.value + ihVal],
    a.time,
    a.value,
    b.time,
    b.value,
  );
  const s = solveParamForX(a.time, cp[0], cp[2], b.time, t);
  return bezierAt(a.value, cp[1], cp[3], b.value, s);
}

/** Sample a sorted scalar keyframe list at time t (clamp ends, interpolate mid). */
export function sampleScalarKeyframes(keys: readonly ScalarKey[], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].time && t <= keys[i + 1].time) {
      const a = keys[i];
      const b = keys[i + 1];
      return a.handleType === undefined && b.handleType === undefined
        ? segmentScalar(a, b, t)
        : segmentScalarTyped(keys, i, t);
    }
  }
  return last.value;
}

/** Interpolate ONE vec3 segment a→b at absolute time t. The TIME handles are
 *  shared across components (one BezierHandle<Vec3>), so the x→s solve is done
 *  ONCE; only the per-component Y control points differ. */
function segmentVec3(a: Vec3Key, b: Vec3Key, t: number): Vec3 {
  const span = b.time - a.time;
  if (span <= 0) return a.value;
  // #272 — equation interpolation: one shared eased fraction across all components.
  if (EQUATION_INTERPS.has(b.easing)) {
    const f = easeFraction(b.easing, b.ease ?? 'inout', (t - a.time) / span);
    return [
      a.value[0] + (b.value[0] - a.value[0]) * f,
      a.value[1] + (b.value[1] - a.value[1]) * f,
      a.value[2] + (b.value[2] - a.value[2]) * f,
    ];
  }
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

/** Project a vec-N keyframe list onto ONE scalar axis, carrying handleType +
 *  per-axis handle offsets. #273 handle-typed vec segments sample per-component
 *  through this because each axis is its own F-curve with its own auto tangent. */
function projectVecAxis(
  keys: ReadonlyArray<Vec2Key | Vec3Key>,
  axis: number,
): readonly ScalarKey[] {
  return keys.map((k) => ({
    time: k.time,
    value: (k.value as readonly number[])[axis],
    easing: k.easing,
    ease: k.ease,
    handleType: k.handleType,
    inHandle: k.inHandle
      ? { time: k.inHandle.time, value: (k.inHandle.value as readonly number[])[axis] }
      : undefined,
    outHandle: k.outHandle
      ? { time: k.outHandle.time, value: (k.outHandle.value as readonly number[])[axis] }
      : undefined,
  }));
}

/** Sample a sorted vec3 keyframe list at time t (clamp ends, interpolate mid). */
export function sampleVec3Keyframes(keys: readonly Vec3Key[], t: number): Vec3 {
  if (keys.length === 0) return [0, 0, 0];
  // #273 — a handle-typed channel samples per-component through the scalar path so
  // render == the per-axis curve display (H40). Opt-in: absent handleType → fast path.
  if (anyHandleType(keys)) {
    return [
      sampleScalarKeyframes(projectVecAxis(keys, 0), t),
      sampleScalarKeyframes(projectVecAxis(keys, 1), t),
      sampleScalarKeyframes(projectVecAxis(keys, 2), t),
    ];
  }
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
  // #272 — equation interpolation: one shared eased fraction across both components.
  if (EQUATION_INTERPS.has(b.easing)) {
    const f = easeFraction(b.easing, b.ease ?? 'inout', (t - a.time) / span);
    return [a.value[0] + (b.value[0] - a.value[0]) * f, a.value[1] + (b.value[1] - a.value[1]) * f];
  }
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
  // #273 — handle-typed channel samples per-component (see sampleVec3Keyframes).
  if (anyHandleType(keys)) {
    return [
      sampleScalarKeyframes(projectVecAxis(keys, 0), t),
      sampleScalarKeyframes(projectVecAxis(keys, 1), t),
    ];
  }
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
  modifiers?: readonly FChannelModifier[],
): number {
  // #277 — TIME phase: remap the sample time (Stepped / Limits-X) BEFORE reading the
  // base curve. Identity when no time modifier is present → st === t bit-for-bit, so
  // the base sample and the value phase are byte-identical for every existing channel.
  const st = modifiers && modifiers.length ? resolveSampleTime(t, modifiers) : t;
  const base = scalarExtendedBase(keys, st, before, after, cyclesBefore, cyclesAfter);
  // Blender-faithful: value modifiers evaluate at the REMAPPED time (a Stepped above a
  // Noise steps the noise too — devaltime feeds evaluate_value_fmodifiers).
  return modifiers && modifiers.length ? applyChannelModifiers(base, st, modifiers) : base;
}

/** The extended base sample WITHOUT modifiers — the pre-#274 body verbatim, so an
 *  empty modifier stack is byte-identical (D1/V49 parity). */
function scalarExtendedBase(
  keys: readonly ScalarKey[],
  t: number,
  before: ChannelExtend,
  after: ChannelExtend,
  cyclesBefore: number,
  cyclesAfter: number,
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

/** #280 — the effective F-Modifier stack for ONE component of a vec channel: the
 *  per-axis override `axisModifiers[axis]` when present (an EMPTY array is a real
 *  override → that axis is deliberately un-modified), else the shared channel stack.
 *  Absent `axisModifiers` → every axis shares (the sampler fast path). Exported so the
 *  curve editor draws each axis with the SAME stack the sampler renders it with (H40). */
export function modifiersForAxis(
  shared: readonly FChannelModifier[] | undefined,
  axisModifiers: ReadonlyArray<readonly FChannelModifier[] | null> | undefined,
  axis: number,
): readonly FChannelModifier[] | undefined {
  const override = axisModifiers?.[axis];
  return override != null ? override : shared; // null / undefined → shared stack
}

/** Sample a vec2 channel at time `t` with per-side extend rules (#269). */
export function sampleVec2KeyframesExtended(
  keys: readonly Vec2Key[],
  t: number,
  before: ChannelExtend = 'hold',
  after: ChannelExtend = 'hold',
  cyclesBefore = 0,
  cyclesAfter = 0,
  modifiers?: readonly FChannelModifier[],
  axisModifiers?: ReadonlyArray<readonly FChannelModifier[] | null>,
): Vec2 {
  // #280 — PER-AXIS independent stacks (opt-in): each component samples through the
  // scalar path with its OWN effective stack, resolving its own time (Stepped/Limits-X)
  // + value phase, so e.g. a Noise on X alone jitters only X (Blender: each axis is an
  // independent F-curve). Cycles/extrapolation stay channel-level (before/after resolved
  // upstream from the shared stack). Absent axisModifiers → the fast path, byte-identical.
  if (axisModifiers && axisModifiers.length) {
    return [
      sampleScalarKeyframesExtended(
        projectVecAxis(keys, 0),
        t,
        before,
        after,
        cyclesBefore,
        cyclesAfter,
        modifiersForAxis(modifiers, axisModifiers, 0),
      ),
      sampleScalarKeyframesExtended(
        projectVecAxis(keys, 1),
        t,
        before,
        after,
        cyclesBefore,
        cyclesAfter,
        modifiersForAxis(modifiers, axisModifiers, 1),
      ),
    ];
  }
  // #277 — TIME phase remaps the (shared) sample time once; components sample at st.
  const st = modifiers && modifiers.length ? resolveSampleTime(t, modifiers) : t;
  const base = vec2ExtendedBase(keys, st, before, after, cyclesBefore, cyclesAfter);
  // #274 — modifiers apply identically per-component (one modifier = one function
  // of time, Blender-consistent) so the per-axis curve display matches render (H40).
  if (!modifiers || modifiers.length === 0) return base;
  return [
    applyChannelModifiers(base[0], st, modifiers),
    applyChannelModifiers(base[1], st, modifiers),
  ];
}

function vec2ExtendedBase(
  keys: readonly Vec2Key[],
  t: number,
  before: ChannelExtend,
  after: ChannelExtend,
  cyclesBefore: number,
  cyclesAfter: number,
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
  modifiers?: readonly FChannelModifier[],
  axisModifiers?: ReadonlyArray<readonly FChannelModifier[] | null>,
): Vec3 {
  // #280 — PER-AXIS independent stacks (opt-in); see sampleVec2KeyframesExtended.
  if (axisModifiers && axisModifiers.length) {
    return [
      sampleScalarKeyframesExtended(
        projectVecAxis(keys, 0),
        t,
        before,
        after,
        cyclesBefore,
        cyclesAfter,
        modifiersForAxis(modifiers, axisModifiers, 0),
      ),
      sampleScalarKeyframesExtended(
        projectVecAxis(keys, 1),
        t,
        before,
        after,
        cyclesBefore,
        cyclesAfter,
        modifiersForAxis(modifiers, axisModifiers, 1),
      ),
      sampleScalarKeyframesExtended(
        projectVecAxis(keys, 2),
        t,
        before,
        after,
        cyclesBefore,
        cyclesAfter,
        modifiersForAxis(modifiers, axisModifiers, 2),
      ),
    ];
  }
  // #277 — TIME phase remaps the (shared) sample time once; components sample at st.
  const st = modifiers && modifiers.length ? resolveSampleTime(t, modifiers) : t;
  const base = vec3ExtendedBase(keys, st, before, after, cyclesBefore, cyclesAfter);
  if (!modifiers || modifiers.length === 0) return base;
  return [
    applyChannelModifiers(base[0], st, modifiers),
    applyChannelModifiers(base[1], st, modifiers),
    applyChannelModifiers(base[2], st, modifiers),
  ];
}

function vec3ExtendedBase(
  keys: readonly Vec3Key[],
  t: number,
  before: ChannelExtend,
  after: ChannelExtend,
  cyclesBefore: number,
  cyclesAfter: number,
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
