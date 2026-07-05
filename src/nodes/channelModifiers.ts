// channelModifiers — the per-channel F-MODIFIER STACK (#274, V88 D2).
//
// WHY THIS EXISTS
// ===============
// Keyframes + D1 extend (#269–#271) + per-key interpolation/handles (#272/#273)
// author the SHAPE of a channel. Blender's F-Modifiers are the other half: a
// STACK of procedural operators (Noise, Stepped, Limits, Generator, Envelope,
// Cycles) layered ON TOP of the evaluated curve, each with an influence, a
// restricted frame range, and blend-in/out ramps. This module is that stack.
//
// It is applied AFTER the (extended) base sample, inside `sample*KeyframesExtended`
// (keyframeInterp.ts) — ONE place, so every consumer (3D render, read-side
// gizmo/inspector, compositor, curve editor, camera) gets it via `ch.sample()`
// (H40, one band two callers). Empty stack → the sampler is unchanged →
// byte-identical for every existing animation. Opt-in only.
//
// PURITY (the invariant this must not break — H48/H49)
// ====================================================
// Channels are pure: `sample(seconds)` is a function of (params, time) with no
// Math.random, no useFrame. The noise here is a DETERMINISTIC fractal value-noise
// (a hash of the integer lattice + smoothstep) — same (t, params) → same value,
// always. This is what lets the curve editor draw the exact curve that plays.
//
// REF: Blender `source/blender/blenkernel/intern/fcurve_modifiers.cc`
//      (`fcm_noise_evaluate`, `evaluate_fmodifiers`, restricted-range influence);
//      keyframeInterp.ts (the caller); vyapti V88 D2, H48/H49.

import { z } from 'zod';

/** Fields common to EVERY modifier (Blender's per-F-Modifier restricted-range +
 *  influence, shared by the whole stack). Times are in SECONDS (Basher's sample
 *  unit), not frames. All optional → a freshly-added modifier is full-strength. */
export interface FModifierBase {
  /** Skip this modifier without removing it (Blender's per-modifier mute). */
  muted?: boolean;
  /** Global 0..1 blend of this modifier's effect over the incoming value. Default 1. */
  influence?: number;
  /** Restrict the modifier to [rangeStart, rangeEnd] with blend-in/out ramps. */
  useRange?: boolean;
  rangeStart?: number;
  rangeEnd?: number;
  blendIn?: number;
  blendOut?: number;
}

/** How a Noise modifier combines its noise signal `n` with the incoming value. */
export type NoiseBlend = 'add' | 'subtract' | 'multiply' | 'replace';

/** NOISE modifier (Blender FMod_Noise): a fractal value-noise of `t*scale + phase`,
 *  scaled by `strength`, shifted by `offset`, `depth` octaves, combined per `blend`. */
export interface FModNoise extends FModifierBase {
  type: 'noise';
  blend: NoiseBlend;
  strength: number;
  scale: number;
  phase: number;
  offset: number;
  depth: number;
}

/** Per-side cycling mode for a Cycles modifier (Blender FModifierCycles before/after
 *  mode). 'none' = no cycling that side (the channel's extrapolation applies instead). */
export type CycleMode = 'none' | 'repeat' | 'repeat-offset' | 'repeat-mirror';

/** CYCLES modifier (Blender FModifierCycles) — the repeat family that #269–#271
 *  originally folded into the extend enum. UNLIKE Noise it is a TIME modifier: it
 *  remaps evaluation time BEFORE the base curve is sampled, so it is consumed by
 *  {@link resolveExtend} in keyframeInterp.ts (feeding `planExtend`), NOT by the
 *  value-phase {@link applyChannelModifiers} — which skips it. One entry carries
 *  BOTH sides (like Blender). Counts: 0 = infinite; past N the side freezes.
 *  Only `muted` of the shared range fields is honoured (a muted Cycles → the
 *  channel's hold/slope extrapolation applies). */
export interface FModCycles extends FModifierBase {
  type: 'cycles';
  beforeMode: CycleMode;
  afterMode: CycleMode;
  beforeCycles: number;
  afterCycles: number;
}

/** GENERATOR modifier (Blender FMod_Generator, Expanded Polynomial): evaluates
 *  `y = c0 + c1·t + c2·t² + …` (t in SECONDS) and either ADDS it to the incoming
 *  value or REPLACES it. A VALUE modifier (like Noise). `coefficients[i]` is the
 *  factor of tⁱ, so its length is (polynomial order + 1). Factorized-polynomial mode
 *  is DEFERRED. REF: manual `graph_editor/fcurves/modifiers` (Generator Modifier). */
export interface FModGenerator extends FModifierBase {
  type: 'generator';
  /** Add the polynomial to the curve (true) or replace the curve with it (false). */
  additive: boolean;
  /** [c0, c1, c2, …] → c0 + c1·t + c2·t² + … (length = order + 1). */
  coefficients: number[];
}

/** LIMITS modifier (Blender FMod_Limits) — a BOTH-PHASE modifier (#277):
 *  - VALUE (Y) phase, in {@link applyChannelModifiers}: clamp the incoming value to
 *    [minY, maxY], each bound independently enabled.
 *  - TIME (X) phase, in {@link resolveSampleTime}: clamp the sample TIME to [minX, maxX],
 *    each bound independently enabled. Because the clamped time is fed to the base
 *    sampler, the curve holds its boundary value outside the range — Blender's
 *    "constant extrapolate outside frame range". REF: manual `graph_editor/fcurves/
 *    modifiers` (Limits Modifier); Blender `fcm_limits` (time) + `fcm_limits_evaluate` (value). */
export interface FModLimits extends FModifierBase {
  type: 'limits';
  useMinY: boolean;
  useMaxY: boolean;
  minY: number;
  maxY: number;
  /** #277 — the TIME (X) clamp half. Optional/defaulted-off → additive (no migration). */
  useMinX?: boolean;
  useMaxX?: boolean;
  minX?: number;
  maxX?: number;
}

/** STEPPED modifier (Blender FMod_Stepped) — a TIME modifier: snap the sample time to
 *  a grid `offset + floor((t-offset)/step)·step` so the curve HOLDS between steps
 *  (stop-motion / "on Ns"). Like Cycles it remaps evaluation time BEFORE the base
 *  curve is sampled, so it is consumed by {@link resolveSampleTime}, NOT the value-phase
 *  {@link applyChannelModifiers} (which skips it). Stepping optionally applies only
 *  within [frameStart, frameEnd] (Blender's own start/end-frame gates, folded here into
 *  a single `useFrameRange` toggle); outside the range the time passes through unstepped.
 *  Times are in SECONDS. `step <= 0` → identity guard. Only `muted` of the shared range/
 *  influence fields is honoured (time phase ignores generic influence, like Cycles).
 *  REF: manual `graph_editor/fcurves/modifiers` (Stepped Interpolation); Blender `fcm_stepped_time`. */
export interface FModStepped extends FModifierBase {
  type: 'stepped';
  /** Grid size in SECONDS — the curve holds for `step` seconds per stair. */
  step: number;
  /** Phase offset of the grid (shifts where each stair begins). */
  offset: number;
  /** Restrict stepping to [frameStart, frameEnd]; outside → unstepped passthrough. */
  useFrameRange?: boolean;
  frameStart?: number;
  frameEnd?: number;
}

/** One Envelope control point (Blender FCM_EnvelopeData). `min`/`max` are OFFSETS from
 *  the modifier's `reference` to the adjusted band's lower/upper bound at `time` (matching
 *  the UI's "offset from reference value"); interpolated linearly between points, held
 *  outside. Times are in SECONDS. Points are kept sorted by `time` (like keyframes). */
export interface FModEnvelopePoint {
  time: number;
  min: number;
  max: number;
}

/** ENVELOPE modifier (Blender FMod_Envelope) — a VALUE modifier: reshape the curve by
 *  mapping a fixed REFERENCE band `[reference+min, reference+max]` onto a per-time ADJUSTED
 *  band `[reference+p.min, reference+p.max]` interpolated from keyed control points. A value
 *  `v`'s position within the reference band is preserved within the adjusted band, so the
 *  curve is pushed/squeezed/stretched over time. Byte-equivalent to Blender's
 *  `fac = (v-(midval+min))/(max-min); out = bandMin + fac·(bandMax-bandMin)`. No control
 *  points → no-op (Blender `env->data==null → return`). REF: manual `graph_editor/fcurves/
 *  modifiers` (Envelope Modifier); Blender `fcm_envelope_evaluate`. */
export interface FModEnvelope extends FModifierBase {
  type: 'envelope';
  /** The value the envelope is centered around (Blender `midval`). */
  reference: number;
  /** Offset from `reference` to the reference band's lower/upper bound (Blender env min/max). */
  min: number;
  max: number;
  points: FModEnvelopePoint[];
}

/** The channel-modifier union. Envelope (#278) completes the value-phase set. */
export type FChannelModifier =
  | FModNoise
  | FModCycles
  | FModGenerator
  | FModLimits
  | FModStepped
  | FModEnvelope;

/** The modifier TYPES a channel can add (authoring order for the Add menu / e2e). */
export const FMODIFIER_TYPES = [
  'noise',
  'cycles',
  'generator',
  'limits',
  'stepped',
  'envelope',
] as const;

/** A fresh modifier of the given type, with director-friendly defaults. */
export function defaultModifier(type: (typeof FMODIFIER_TYPES)[number]): FChannelModifier {
  switch (type) {
    case 'noise':
      return {
        type: 'noise',
        blend: 'add',
        strength: 1,
        scale: 1,
        phase: 0,
        offset: 0,
        depth: 1,
        influence: 1,
      };
    case 'cycles':
      // A Blender-default cyclic loop: repeat both ends, infinitely.
      return {
        type: 'cycles',
        beforeMode: 'repeat',
        afterMode: 'repeat',
        beforeCycles: 0,
        afterCycles: 0,
      };
    case 'generator':
      // A gentle additive unit-slope ramp (y = t) — visible but not destructive.
      return { type: 'generator', additive: true, coefficients: [0, 1], influence: 1 };
    case 'limits':
      // All four bounds OFF on add (no destructive clamp until the director enables one).
      return {
        type: 'limits',
        useMinY: false,
        useMaxY: false,
        minY: 0,
        maxY: 1,
        useMinX: false,
        useMaxX: false,
        minX: 0,
        maxX: 1,
        influence: 1,
      };
    case 'stepped':
      // A visible 1-second stop-motion hold, unbounded (no frame range on add).
      return {
        type: 'stepped',
        step: 1,
        offset: 0,
        useFrameRange: false,
        frameStart: 0,
        frameEnd: 0,
      };
    case 'envelope':
      // Reference band [-1, +1] around 0; NO control points on add → a no-op until the
      // director adds points (Blender: env->data==null → passthrough). addPoint seeds an
      // identity point (offsets = the global band) so adding one doesn't jump the curve.
      return { type: 'envelope', reference: 0, min: -1, max: 1, points: [], influence: 1 };
  }
}

// ── deterministic fractal value-noise (pure — no Math.random) ───────────────
// A sine-hash of the integer lattice, smoothstep-interpolated → C1-continuous
// value noise in [-1,1], summed over octaves. Deterministic in `x`, so the curve
// the editor draws is the curve that plays (H40).

function hash1(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453123;
  return s - Math.floor(s); // [0,1)
}

function valueNoise1D(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f); // smoothstep → C1
  const a = hash1(i);
  const b = hash1(i + 1);
  return (a + (b - a) * u) * 2 - 1; // [-1,1)
}

/** Fractal (fBm) value-noise: `depth` octaves, halving amplitude, doubling freq,
 *  normalised back to ≈[-1,1]. `depth` clamped to [1,8]. */
export function fractalNoise(x: number, depth: number): number {
  const oct = Math.max(1, Math.min(Math.floor(depth) || 1, 8));
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * valueNoise1D(x * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Effective 0..1 influence of a modifier at time `t`, folding in the global
 *  influence and the restricted-range blend-in/out ramps (Blender). Outside the
 *  restricted range → 0 (the modifier is inert). */
function effectiveInfluence(mod: FChannelModifier, t: number): number {
  let inf = mod.influence ?? 1;
  if (mod.useRange) {
    const start = mod.rangeStart ?? 0;
    const end = mod.rangeEnd ?? 0;
    if (end > start) {
      if (t < start || t > end) return 0;
      const blendIn = mod.blendIn ?? 0;
      const blendOut = mod.blendOut ?? 0;
      if (blendIn > 0 && t < start + blendIn) inf *= (t - start) / blendIn;
      if (blendOut > 0 && t > end - blendOut) inf *= (end - t) / blendOut;
    }
  }
  return Math.max(0, Math.min(inf, 1));
}

/** The noise signal for a Noise modifier at time `t` (before blend/influence). */
function noiseSignal(mod: FModNoise, t: number): number {
  return fractalNoise(t * mod.scale + mod.phase, mod.depth) * mod.strength + mod.offset;
}

/** The Envelope's per-time band OFFSETS at `t`: linearly interpolate the control points'
 *  min/max, holding the first/last outside the point range (Blender `fcm_envelope_evaluate`
 *  segment scan). `null` when there are no points → the modifier is a no-op. Points are
 *  assumed sorted by `time` (the UI keeps them so). */
function envelopeOffsets(
  points: readonly FModEnvelopePoint[],
  t: number,
): { min: number; max: number } | null {
  const n = points.length;
  if (n === 0) return null;
  const first = points[0];
  const last = points[n - 1];
  if (t <= first.time) return { min: first.min, max: first.max };
  if (t >= last.time) return { min: last.min, max: last.max };
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.time <= t && b.time >= t) {
      const diff = b.time - a.time;
      if (diff <= 0) return { min: a.min, max: a.max };
      const afac = (t - a.time) / diff;
      const bfac = (b.time - t) / diff;
      return { min: bfac * a.min + afac * b.min, max: bfac * a.max + afac * b.max };
    }
  }
  return { min: last.min, max: last.max };
}

/** Combine one modifier's raw effect with the incoming value (pre-influence). */
function modifierValue(mod: FChannelModifier, t: number, value: number): number {
  switch (mod.type) {
    case 'noise': {
      const n = noiseSignal(mod, t);
      switch (mod.blend) {
        case 'add':
          return value + n;
        case 'subtract':
          return value - n;
        case 'multiply':
          return value * n;
        case 'replace':
          return n;
      }
      break;
    }
    case 'generator': {
      // Expanded polynomial y = c0 + c1·t + c2·t² + … (Horner-free, order+1 terms).
      let y = 0;
      let pow = 1;
      for (const c of mod.coefficients) {
        y += c * pow;
        pow *= t;
      }
      return mod.additive ? value + y : y;
    }
    case 'limits': {
      let v = value;
      if (mod.useMinY) v = Math.max(v, mod.minY);
      if (mod.useMaxY) v = Math.min(v, mod.maxY);
      return v;
    }
    case 'envelope': {
      // Map the value's position within the REFERENCE band onto the per-time ADJUSTED
      // band. Byte-equivalent to Blender fcm_envelope_evaluate. No points → no-op.
      const band = envelopeOffsets(mod.points, t);
      if (!band) return value;
      const refWidth = mod.max - mod.min;
      if (refWidth === 0) return value; // degenerate reference band → no-op guard
      const refLower = mod.reference + mod.min;
      const adjLower = mod.reference + band.min;
      const adjUpper = mod.reference + band.max;
      const fac = (value - refLower) / refWidth;
      return adjLower + fac * (adjUpper - adjLower);
    }
    // Cycles + Stepped are TIME modifiers (resolveExtend / resolveSampleTime consume
    // them pre-sample), never value ops. Guarded out in applyChannelModifiers; these
    // cases keep the switch exhaustive.
    case 'cycles':
    case 'stepped':
      return value;
  }
  return value;
}

/**
 * Apply a channel's F-Modifier stack to a base scalar value at time `t`. Modifiers
 * run in array order; each one's output (blended over the running value by its
 * effective influence) feeds the next. Empty / undefined stack → `base` verbatim
 * (byte-identical). Muted or zero-influence modifiers are skipped. PURE.
 */
export function applyChannelModifiers(
  base: number,
  t: number,
  modifiers?: readonly FChannelModifier[],
): number {
  if (!modifiers || modifiers.length === 0) return base;
  let v = base;
  for (const mod of modifiers) {
    // Cycles + Stepped are TIME modifiers (resolveExtend / resolveSampleTime consume
    // them pre-sample) — never value ops. Skip them here regardless of mute so the
    // value phase runs only the value-phase modifiers. (Limits IS a value op here —
    // its Y clamp — as well as a time op in resolveSampleTime; it stays in the loop.)
    if (mod.type === 'cycles' || mod.type === 'stepped') continue;
    if (mod.muted) continue;
    const inf = effectiveInfluence(mod, t);
    if (inf === 0) continue;
    const modified = modifierValue(mod, t, v);
    v = v + (modified - v) * inf;
  }
  return v;
}

// ── TIME phase (#277) — remap the sample time BEFORE the base curve is read ──
// Blender's `evaluate_time_fmodifiers`: Stepped + Limits-X transform `evaltime`.
// Cycles is ALSO a time modifier but Basher folds it into resolveExtend/planExtend
// (keyframeInterp.ts), so it is deliberately NOT handled here — resolveSampleTime is
// composed ALONGSIDE Cycles, not replacing it. Pure; identity when no time modifier
// is present, so an empty / value-only stack keeps the sampler byte-identical.

/** Snap `t` to a Stepped modifier's grid. `step <= 0` → identity (no divide). When
 *  `useFrameRange`, times outside [frameStart, frameEnd] pass through unstepped. */
function snapStepped(mod: FModStepped, t: number): number {
  const step = mod.step;
  if (!(step > 0)) return t;
  if (mod.useFrameRange) {
    const s = mod.frameStart ?? 0;
    const e = mod.frameEnd ?? 0;
    if (e > s && (t < s || t > e)) return t;
  }
  const offset = mod.offset ?? 0;
  return offset + Math.floor((t - offset) / step) * step;
}

/** Clamp `t` to a Limits modifier's TIME (X) window. Each bound independent; a bound
 *  that is off leaves that side untouched (so all-off → identity, byte-identical). */
function clampLimitsX(mod: FModLimits, t: number): number {
  let tt = t;
  if (mod.useMinX) tt = Math.max(tt, mod.minX ?? 0);
  if (mod.useMaxX) tt = Math.min(tt, mod.maxX ?? 0);
  return tt;
}

/**
 * Resolve the effective SAMPLE TIME for a channel's F-Modifier stack (#277) — the
 * time-phase counterpart of {@link applyChannelModifiers}. Runs the time modifiers
 * (Stepped, Limits-X) in array order, each transforming the running time. Honours
 * `muted`; ignores generic influence/range (Blender's time phase does too). Cycles,
 * Noise, Generator are no-ops here. Empty / value-only stack → `t` unchanged
 * (bit-identical), so the sampler stays byte-identical for every existing animation.
 */
export function resolveSampleTime(t: number, modifiers?: readonly FChannelModifier[]): number {
  if (!modifiers || modifiers.length === 0) return t;
  let st = t;
  for (const mod of modifiers) {
    if (mod.muted) continue;
    if (mod.type === 'stepped') st = snapStepped(mod, st);
    else if (mod.type === 'limits') st = clampLimitsX(mod, st);
  }
  return st;
}

// ── zod schema (shared by the 3 KeyframeChannel schemas) ────────────────────
// The common restricted-range fields are `.optional()` (absent → full strength),
// the noise params carry director-friendly defaults. Discriminated on `type` so
// the union grows without touching callers. The DAG stores zod-PARSED params, so
// every field a modifier reads is present (defaults applied) after parse.

const rangeFields = {
  muted: z.boolean().optional(),
  influence: z.number().min(0).max(1).optional(),
  useRange: z.boolean().optional(),
  rangeStart: z.number().optional(),
  rangeEnd: z.number().optional(),
  blendIn: z.number().optional(),
  blendOut: z.number().optional(),
};

const cycleModeSchema = z.enum(['none', 'repeat', 'repeat-offset', 'repeat-mirror']);

export const FModifierSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noise'),
    blend: z.enum(['add', 'subtract', 'multiply', 'replace']).default('add'),
    strength: z.number().default(1),
    scale: z.number().default(1),
    phase: z.number().default(0),
    offset: z.number().default(0),
    depth: z.number().int().min(1).max(8).default(1),
    ...rangeFields,
  }),
  z.object({
    type: z.literal('cycles'),
    beforeMode: cycleModeSchema.default('none'),
    afterMode: cycleModeSchema.default('none'),
    beforeCycles: z.number().int().min(0).default(0),
    afterCycles: z.number().int().min(0).default(0),
    ...rangeFields,
  }),
  z.object({
    type: z.literal('generator'),
    additive: z.boolean().default(true),
    coefficients: z.array(z.number()).default([0, 1]),
    ...rangeFields,
  }),
  z.object({
    type: z.literal('limits'),
    useMinY: z.boolean().default(false),
    useMaxY: z.boolean().default(false),
    minY: z.number().default(0),
    maxY: z.number().default(1),
    // #277 — the TIME (X) clamp half (optional/defaulted-off → additive, no migration).
    useMinX: z.boolean().default(false),
    useMaxX: z.boolean().default(false),
    minX: z.number().default(0),
    maxX: z.number().default(1),
    ...rangeFields,
  }),
  z.object({
    type: z.literal('stepped'),
    step: z.number().default(1),
    offset: z.number().default(0),
    useFrameRange: z.boolean().default(false),
    frameStart: z.number().default(0),
    frameEnd: z.number().default(0),
    ...rangeFields,
  }),
  z.object({
    type: z.literal('envelope'),
    reference: z.number().default(0),
    min: z.number().default(-1),
    max: z.number().default(1),
    points: z.array(z.object({ time: z.number(), min: z.number(), max: z.number() })).default([]),
    ...rangeFields,
  }),
]);

/** The per-channel modifier array param — default `[]` → byte-identical no-op. */
export const ChannelModifiersSchema = z.array(FModifierSchema).default([]);

/** #280 — the OPTIONAL per-axis modifier override for vec channels. Entry `i` is either
 *  an F-Modifier stack that REPLACES the shared {@link ChannelModifiersSchema} `modifiers`
 *  for component `i` (an EMPTY array deliberately leaves that axis un-modified), or `null`
 *  → axis `i` falls back to the shared stack. Stored dense (length = the channel's vec
 *  arity, `null` where not overridden) so it is JSON/zod-safe (no sparse holes). The whole
 *  array absent → every axis shares → byte-identical to pre-#280 (the vec sampler's fast
 *  path). Blender models each axis as an independent F-curve with its own stack; this is
 *  the opt-in override that unlocks that (a Noise on X alone jitters only X). */
export const AxisModifiersSchema = z.array(z.array(FModifierSchema).nullable()).optional();

// ── #275 — migrate the D1 extend/cycle enum into a Cycles modifier ───────────
// The D1 extend enum (#269–#271) collapsed hold/slope (extrapolation) AND
// cycle/cycle-offset/mirror (the repeat family) into one per-side param + counts.
// Blender splits these: hold/slope stay the F-Curve `extrapolation` property; the
// repeat family is the FModifierCycles MODIFIER. This helper performs that split on
// a raw (v1) params object so the migration is byte-identical (resolveExtend maps it
// straight back onto the unchanged planExtend inputs). REF: issue #275, vyapti V88 D2.

const REPEAT_MODE_OF: Record<string, CycleMode> = {
  cycle: 'repeat',
  'cycle-offset': 'repeat-offset',
  mirror: 'repeat-mirror',
};

/** Split a v1 channel's `extend{Before,After}` (5-enum) + `cycles{Before,After}`
 *  into the v2 shape: `extend{Before,After}` narrowed to hold/slope + a prepended
 *  Cycles modifier for any repeating side. hold/slope carry no count (Blender's
 *  LINEAR/CONSTANT extrapolation is unbounded) — a stray slope+count>0 (only
 *  reachable via raw JSON, never the UI) is dropped and warned (no silent loss). */
export function migrateExtendParamsToCycles(params: unknown): {
  extendBefore: 'hold' | 'slope';
  extendAfter: 'hold' | 'slope';
  modifiers: unknown[];
} {
  const p = (params ?? {}) as {
    extendBefore?: string;
    extendAfter?: string;
    cyclesBefore?: number;
    cyclesAfter?: number;
    modifiers?: unknown[];
  };
  const eb = p.extendBefore ?? 'hold';
  const ea = p.extendAfter ?? 'hold';
  const beforeMode = REPEAT_MODE_OF[eb] ?? 'none';
  const afterMode = REPEAT_MODE_OF[ea] ?? 'none';
  if (
    (beforeMode === 'none' && (p.cyclesBefore ?? 0) > 0) ||
    (afterMode === 'none' && (p.cyclesAfter ?? 0) > 0)
  ) {
    console.warn(
      '[migration #275] dropping a count on a non-cycling extend side (hold/slope carry no count).',
    );
  }
  const existing = Array.isArray(p.modifiers) ? p.modifiers : [];
  const cyclesEntry =
    beforeMode === 'none' && afterMode === 'none'
      ? []
      : [
          {
            type: 'cycles' as const,
            beforeMode,
            afterMode,
            beforeCycles: beforeMode === 'none' ? 0 : (p.cyclesBefore ?? 0),
            afterCycles: afterMode === 'none' ? 0 : (p.cyclesAfter ?? 0),
          },
        ];
  return {
    extendBefore: beforeMode === 'none' ? (eb === 'slope' ? 'slope' : 'hold') : 'hold',
    extendAfter: afterMode === 'none' ? (ea === 'slope' ? 'slope' : 'hold') : 'hold',
    modifiers: [...cyclesEntry, ...existing],
  };
}
