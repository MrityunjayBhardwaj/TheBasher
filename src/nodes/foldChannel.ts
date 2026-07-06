// foldChannel — the NLA reducer (the one new thing, epic #283 Phase 1).
//
// Replaces overlayChannels' single-slot last-writer-wins loop with a bottom→top
// weighted stack-fold per (target, param). Multiple contributions to ONE param
// combine by an ORDERED, WEIGHTED, explicit-blend-mode fold — never scan-order-
// dependent (fixes V88 D3; advances D2 in motion space). This is the resolver
// AnimationLayer.ts:88-92 punted to "a future SceneAnimation aggregator that
// knows about all layers". This is that aggregator.
//
// PURE: no store reads, no three.js (V32/V34 — the substrate is three-free; the
// quaternion path lifts the pure slerp/qmul from quatMath). Consumed by BOTH the
// scene overlay (overlayChannels) AND the compositor read seam
// (resolveEvaluatedParam) so render == read == compositor for stacked params
// (H40 — one reducer, all consumers).
//
// GROUNDING (Blender source `anim_sys.cc`, via docs/NLA-DESIGN.md §3.2 / §2.1):
//   - Replace  `lower·(1−inf) + strip·inf`         (:1871)  — EXACTLY today's lerp
//   - Combine  add:      `lower + (strip − 0)·inf`  (:1892, identity 0)
//              multiply: `lower · (strip / 1)^inf`  (:1898, identity 1, scale)
//              quat:     `lower ⊗ strip^inf`        (nla_combine_quaternion :2017)
//   - inf == 0 short-circuits to lower              (:1847) — free byte-identity
//   The COMBINE reference is the per-TYPE IDENTITY (0 / 1 / quat-identity), NOT
//   the fold accumulator (I-4 — Blender source corrected the C4D/Houdini docs-
//   inference): a full-influence combine layer over an empty stack reproduces the
//   source, because `id + (strip−id)·1 == strip` and `qmul(id, strip^1) == strip`.
//
// REF: docs/NLA-DESIGN.md §3.1/§3.2/§11; vyapti V88 D2/D3, I-2/I-4/I-5; V57.

import type { ChannelBlendMode, KeyframeChannelValue, Quat, Vec2, Vec3 } from './types';
import { IDENTITY_QUAT, qmul, slerp } from './quatMath';

// ChannelBlendMode is canonical in types.ts (the base module) so the schemas and
// this reducer bind to ONE list. Re-exported for callers that reach it via the
// reducer.
export type { ChannelBlendMode };

/** One layer's contribution to a single (target, param) fold, already sampled at
 *  the current time and ordered bottom→top by the caller. */
export interface ChannelContribution {
  /** The sampled value at this param (ch.sample(seconds)). */
  readonly value: unknown;
  readonly mode: ChannelBlendMode;
  /** Effective blend weight ∈ [0,1] (caller weight × per-channel weight). */
  readonly influence: number;
}

type ValueType = KeyframeChannelValue['valueType'];

const clamp01 = (w: number): number => Math.max(0, Math.min(1, w));

/** A param is a SCALE param → COMBINE multiplies (identity 1) instead of adding
 *  (identity 0). `valueType` alone can't tell add from multiply (both 'vec3'), so
 *  we detect scale by paramPath — matching how the rest of the substrate names
 *  scale (Phase-1 decision D3). */
function isScaleParam(paramPath: string): boolean {
  return paramPath === 'scale' || paramPath.endsWith('.scale');
}

/**
 * Fold an ordered contribution list onto `base`, per param. `contribs` must be
 * ordered bottom→top (the caller sorts by `order`). Empty list → `base` verbatim
 * (byte-identity). A single REPLACE contribution at influence 1 → the strip value
 * → matches today's last-writer, so the existing-animation gate holds by
 * construction.
 */
export function foldChannelValue(
  base: unknown,
  contribs: readonly ChannelContribution[],
  valueType: ValueType,
  paramPath: string,
): unknown {
  let acc = base;
  const scale = isScaleParam(paramPath);
  for (const c of contribs) {
    acc = blendOne(acc, c.value, c.mode, clamp01(c.influence), valueType, scale);
  }
  return acc;
}

function blendOne(
  lower: unknown,
  strip: unknown,
  mode: ChannelBlendMode,
  inf: number,
  valueType: ValueType,
  scale: boolean,
): unknown {
  // inf == 0 → the contribution vanishes (muted / zero-weight strip). Free
  // byte-identity, and the reason a bare un-keyed channel never perturbs base.
  if (inf <= 0) return lower ?? strip;
  return mode === 'combine'
    ? combineBlend(lower, strip, inf, valueType, scale)
    : replaceBlend(lower, strip, valueType, inf);
}

// ---------------------------------------------------------------------------
// REPLACE — verbatim the legacy overlayChannels `blend` (proven byte-identical by
// overlayChannels.test.ts). Do NOT "improve" this: it is the byte-identity anchor.
// number/vec lerp; quat slerps (I-5 — at inf=1, the default, slerp(a,b,1)===b, so
// every real default-weight quat channel is byte-identical to the old half-snap);
// color/text/image snap at the half-weight mark.
// ---------------------------------------------------------------------------
function replaceBlend(
  original: unknown,
  channelValue: unknown,
  valueType: ValueType,
  weight: number,
): unknown {
  const w = clamp01(weight);
  if (w >= 1) return channelValue;
  if (w <= 0) return original ?? channelValue;
  if (valueType === 'number' && typeof original === 'number' && typeof channelValue === 'number') {
    return original + (channelValue - original) * w;
  }
  if (valueType === 'vec2' && isVec(original, 2) && isVec(channelValue, 2)) {
    return lerpVec(original, channelValue, w);
  }
  if (valueType === 'vec3' && isVec(original, 3) && isVec(channelValue, 3)) {
    return lerpVec(original, channelValue, w);
  }
  if (valueType === 'quat' && isVec(original, 4) && isVec(channelValue, 4)) {
    return slerp(original as unknown as Quat, channelValue as unknown as Quat, w);
  }
  // color / text / image (discrete / non-manifold): snap at the half-weight mark.
  return w >= 0.5 ? channelValue : (original ?? channelValue);
}

// ---------------------------------------------------------------------------
// COMBINE — additive / multiplicative / manifold layering over the per-type
// IDENTITY (I-4). number & vec: `lower + strip·inf` (identity 0) or, for a scale
// param, `lower · strip^inf` (identity 1). quat: `lower ⊗ strip^inf`. color /
// text / image have no combine algebra → fall through to REPLACE (documented).
// ---------------------------------------------------------------------------
function combineBlend(
  lower: unknown,
  strip: unknown,
  inf: number,
  valueType: ValueType,
  scale: boolean,
): unknown {
  if (valueType === 'number' && typeof lower === 'number' && typeof strip === 'number') {
    return scale ? lower * Math.pow(strip, inf) : lower + strip * inf;
  }
  if (valueType === 'vec2' && isVec(lower, 2) && isVec(strip, 2)) {
    return combineVec(lower, strip, inf, scale);
  }
  if (valueType === 'vec3' && isVec(lower, 3) && isVec(strip, 3)) {
    return combineVec(lower, strip, inf, scale);
  }
  if (valueType === 'quat' && isVec(lower, 4) && isVec(strip, 4)) {
    // normalize is implicit in slerp/qmul on unit inputs; strip^inf then compose.
    return qmul(lower as unknown as Quat, slerp(IDENTITY_QUAT, strip as unknown as Quat, inf));
  }
  // No manifold algebra for color/text/image — combine degrades to replace.
  return replaceBlend(lower, strip, valueType, inf);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function isVec(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number');
}

function lerpVec(a: number[], b: number[], w: number): Vec2 | Vec3 {
  return a.map((x, i) => x + (b[i] - x) * w) as unknown as Vec2 | Vec3;
}

/** COMBINE per component: additive (identity 0) → `a + b·inf`; scale (identity 1)
 *  → `a · b^inf`. */
function combineVec(a: number[], b: number[], inf: number, scale: boolean): Vec2 | Vec3 {
  return a.map((x, i) => (scale ? x * Math.pow(b[i], inf) : x + b[i] * inf)) as unknown as
    | Vec2
    | Vec3;
}
