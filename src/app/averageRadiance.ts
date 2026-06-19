// averageRadiance — the energy-faithful reduction of a textured area emitter to
// the single color + intensity three.js's RectAreaLight can carry (epic #201,
// slice #205).
//
// WHY a reduction at all: a textured studio light is a PAIR in three.js (§1.5) —
// the visible HDR card (a real emissive plane, shows the full texture + in
// reflections) PLUS a RectAreaLight that actually illuminates. The RectAreaLight
// is an LTC approximation and CANNOT be textured: it emits ONE color. Blender's
// Cycles never reduces — it importance-samples every texel of the emitter; the
// reduction exists only because our raster RectAreaLight can't. The DC term (the
// MEAN radiance over the texture) is the constant emission that preserves the
// emitter's TOTAL FLUX — so the LTC light matches the energy Cycles integrates.
//
// Pure: a THREE.Texture's pixel data in → numbers out (no three scene state). The
// SAME reduction feeds the viewport and the offscreen render (V37 parity), and is
// computed from the SAME texture the card shows (so card and illumination agree).
//
// REF: docs/OPERATORS-AND-LIGHTING-DESIGN.md §1.5 / §7.1; vyapti V47 (the env
//      HDRI store the `tex` comes from); three DataUtils.fromHalfFloat.

import * as THREE from 'three';

export interface TextureAverage {
  /** Mean linear radiance, red channel. */
  readonly r: number;
  /** Mean linear radiance, green channel. */
  readonly g: number;
  /** Mean linear radiance, blue channel. */
  readonly b: number;
  /** Rec.709 luminance of the mean radiance. */
  readonly luminance: number;
}

/** Rec.709 luma weights — the standard linear-light luminance basis. */
const REC709 = [0.2126, 0.7152, 0.0722] as const;

/** A neutral fallback when a texture has no readable CPU data (e.g. a
 *  compressed/GPU-only texture): treat it as a unit white emitter so the light
 *  still works rather than going black. */
const NEUTRAL: TextureAverage = { r: 1, g: 1, b: 1, luminance: 1 };

/** Read one channel of texel `i` (component offset `c`), decoding half-float
 *  storage (RGBELoader / EXRLoader return HalfFloat DataTextures). */
function readChannel(
  data: ArrayLike<number>,
  base: number,
  c: number,
  comps: number,
  isHalf: boolean,
): number {
  // Single-channel data (comps === 1) replicates the red channel for g/b.
  const idx = base + Math.min(c, comps - 1);
  const raw = data[idx];
  return isHalf ? THREE.DataUtils.fromHalfFloat(raw) : raw;
}

/**
 * Mean linear radiance of an HDR texture's pixels — the flux-preserving reduction
 * of a textured emitter to the RectAreaLight's single color + intensity (§1.5).
 *
 * Handles HalfFloat (Uint16 via `DataUtils.fromHalfFloat`) and Float storage, and
 * 1–4 components per texel (alpha ignored). Returns a NEUTRAL white when the
 * texture carries no CPU-readable data — never throws, never blacks the light.
 */
export function averageRadiance(texture: THREE.Texture | null | undefined): TextureAverage {
  const image = texture?.image as
    | { data?: ArrayLike<number>; width?: number; height?: number }
    | undefined;
  const data = image?.data;
  if (!data || data.length === 0) return NEUTRAL;

  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  // Prefer the declared dimensions; fall back to assuming RGBA when absent.
  const texels = width > 0 && height > 0 ? width * height : Math.floor(data.length / 4);
  if (texels <= 0) return NEUTRAL;
  const comps = Math.max(1, Math.round(data.length / texels));
  const isHalf = texture?.type === THREE.HalfFloatType;

  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < texels; i++) {
    const base = i * comps;
    sr += readChannel(data, base, 0, comps, isHalf);
    sg += readChannel(data, base, 1, comps, isHalf);
    sb += readChannel(data, base, 2, comps, isHalf);
  }
  const r = sr / texels;
  const g = sg / texels;
  const b = sb / texels;
  const luminance = REC709[0] * r + REC709[1] * g + REC709[2] * b;
  return { r, g, b, luminance };
}

/** The RectAreaLight drive derived from a texture average: a unit-luminance chroma
 *  (so the texture's HUE tints the light while its BRIGHTNESS rides on the
 *  intensity scale) plus an `intensityScale` = the mean luminance (the authored
 *  `intensity` multiplies this, so a brighter texture casts more light). A black
 *  texture → scale 0 (no contribution), white fallback color. */
export interface StudioLightDrive {
  /** Linear, unit-luminance chroma — multiply into the light's color. */
  readonly color: readonly [number, number, number];
  /** Multiplier on the authored intensity (the texture's mean luminance). */
  readonly intensityScale: number;
}

export function studioLightDrive(avg: TextureAverage): StudioLightDrive {
  const lum = avg.luminance;
  if (lum <= 1e-6) return { color: [1, 1, 1], intensityScale: 0 };
  return { color: [avg.r / lum, avg.g / lum, avg.b / lum], intensityScale: lum };
}
