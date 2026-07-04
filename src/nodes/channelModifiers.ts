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

/** The channel-modifier union. Grows with Stepped / Limits / Generator / Cycles. */
export type FChannelModifier = FModNoise;

/** The modifier TYPES a channel can add (authoring order for the Add menu / e2e). */
export const FMODIFIER_TYPES = ['noise'] as const;

/** A fresh Noise modifier — a gentle additive jitter (visible but not destructive). */
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
    }
  }
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
    if (mod.muted) continue;
    const inf = effectiveInfluence(mod, t);
    if (inf === 0) continue;
    const modified = modifierValue(mod, t, v);
    v = v + (modified - v) * inf;
  }
  return v;
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
]);

/** The per-channel modifier array param — default `[]` → byte-identical no-op. */
export const ChannelModifiersSchema = z.array(FModifierSchema).default([]);
