// materialSchema — the ONE place the OpenPBR inline-material IR (v0.6 #2, #178)
// is defined as a zod schema, migrated (v2→v3), and hydrated. This module IS the
// span of the [[V10]]/[[H14]] three-layer migration guard for the inline material:
//
//   layer 1 — zod `.default` (NEW-node defaults = the OpenPBR table)   → openpbrMaterialSchema
//   layer 2 — migrations[2]  (MIGRATED-node defaults = CURRENT look)   → migrateInlineMaterialV2toV3
//   layer 3 — evaluator/consumer `?? default` hydrate seam              → hydrateInlineMaterial
//
// Keeping all three in ONE module is the domain-aligned boundary: the invariant
// "every new IR field has a lossless default at every layer" can be enforced and
// audited in one file instead of drifting across BoxMesh/SphereMesh/resolver.
//
// THE R1 TWO-DEFAULTS-ON-PURPOSE SPLIT (do NOT "fix" the discrepancy):
//   • NEW boxes (zod) get OpenPBR specular.roughness = 0.3 (the correct look).
//   • MIGRATED boxes (migrations[2]) get 0.5 — the CURRENT renderer constant
//     (SceneFromDAG.tsx applyOverride no-override branch) — so a saved project
//     renders BYTE-IDENTICALLY after the widen. Two deliberate defaults.
//
// REF: CONTEXT D-02/D-03 + HARD CONSTRAINTS (V10/H14); PLAN W1 (1.2/1.3/1.4);
//      vyapti V10/V32; hetvabhasa H14; issue #178.

import { z } from 'zod';
import type { InlineMaterialSpec } from './types';

/** The renderer's current no-override roughness (SceneFromDAG.tsx applyOverride). */
export const CURRENT_LOOK_ROUGHNESS = 0.5;

// A persisted texture handle (mirrors BakedTextureRef in types.ts). Map slots are
// null until W5 attaches an image.
const bakedTextureRefSchema = z.object({
  hash: z.string(),
  colorSpace: z.enum(['srgb', 'srgb-linear', 'no-colorspace']),
  flipY: z.boolean(),
  wrapS: z.number(),
  wrapT: z.number(),
});
const mapSlot = bakedTextureRefSchema.nullable().default(null);
const NULL_MAPS = {
  albedo: null,
  normal: null,
  roughness: null,
  metalness: null,
  emissive: null,
  ao: null,
} as const;
const mapsSchema = z
  .object({
    albedo: mapSlot,
    normal: mapSlot,
    roughness: mapSlot,
    metalness: mapSlot,
    emissive: mapSlot,
    ao: mapSlot,
  })
  .default({ ...NULL_MAPS });

/**
 * The OpenPBR core-10 inline-material zod schema (layer 1 — NEW-node defaults).
 * Every field AND every nested object carries a `.default` so a partial `setParam`
 * whole-params re-parse (ops.ts) always fills siblings (R6). `baseColorDefault`
 * differs per primitive (box green, sphere blue) — the only per-node difference.
 */
export function openpbrMaterialSchema(baseColorDefault: string) {
  return z
    .object({
      name: z.string().default('default'),
      base: z
        .object({
          color: z.string().default(baseColorDefault),
          metalness: z.number().default(0),
        })
        .default({ color: baseColorDefault, metalness: 0 }),
      specular: z
        .object({
          roughness: z.number().default(0.3), // OpenPBR new-box default (R1: NOT 0.5)
          ior: z.number().default(1.5),
        })
        .default({ roughness: 0.3, ior: 1.5 }),
      coat: z
        .object({
          weight: z.number().default(0),
          roughness: z.number().default(0),
        })
        .default({ weight: 0, roughness: 0 }),
      transmission: z
        .object({
          weight: z.number().default(0),
        })
        .default({ weight: 0 }),
      emission: z
        .object({
          color: z.string().default('#000000'),
          luminance: z.number().default(0),
        })
        .default({ color: '#000000', luminance: 0 }),
      geometry: z
        .object({
          opacity: z.number().default(1),
        })
        .default({ opacity: 1 }),
      maps: mapsSchema,
      unsupported: z.record(z.string(), z.number()).optional(),
    })
    .default({});
}

/**
 * Migrate a v2 inline material `{name,color}` → the v3 OpenPBR IR, seeding the
 * scalars to the CURRENT rendered look (R1 — roughness 0.5, NOT the OpenPBR 0.3),
 * so a saved project renders byte-identically. `base.color` is preserved from the
 * old `color`. THIS IS DELIBERATELY DIFFERENT from the zod NEW-node defaults.
 */
export function migrateInlineMaterialV2toV3(
  oldMaterial: unknown,
  fallbackColor: string,
): InlineMaterialSpec {
  const m = (oldMaterial ?? {}) as { name?: unknown; color?: unknown };
  return {
    name: typeof m.name === 'string' ? m.name : 'default',
    base: { color: typeof m.color === 'string' ? m.color : fallbackColor, metalness: 0 },
    specular: { roughness: CURRENT_LOOK_ROUGHNESS, ior: 1.5 }, // R1: current look, not 0.3
    coat: { weight: 0, roughness: 0 },
    transmission: { weight: 0 },
    emission: { color: '#000000', luminance: 0 },
    geometry: { opacity: 1 },
    maps: { ...NULL_MAPS },
  };
}

interface PartialLobe {
  color?: unknown;
  metalness?: unknown;
  roughness?: unknown;
  ior?: unknown;
  weight?: unknown;
  luminance?: unknown;
  opacity?: unknown;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * The evaluator/consumer hydrate guard (layer 3 — `?? default`). The hydrate seam
 * bypasses zod (in-memory state surgery / agent ops / fixtures), so read every
 * field with a default. DUAL-ACCEPT (CAVEAT-1): a legacy top-level `color`
 * (a pre-migration in-memory `{name,color}`) is accepted as `base.color`, so a
 * mid-migration material never silently drops to a wrong look. Always returns a
 * COMPLETE IR.
 */
export function hydrateInlineMaterial(raw: unknown, baseColorDefault: string): InlineMaterialSpec {
  const m = (raw ?? {}) as {
    name?: unknown;
    color?: unknown; // legacy top-level (pre-migration)
    base?: PartialLobe;
    specular?: PartialLobe;
    coat?: PartialLobe;
    transmission?: PartialLobe;
    emission?: PartialLobe;
    geometry?: PartialLobe;
    maps?: Partial<InlineMaterialSpec['maps']>;
    unsupported?: Record<string, number>;
  };
  const legacyColor = typeof m.color === 'string' ? m.color : undefined;
  const out: InlineMaterialSpec = {
    name: str(m.name, 'default'),
    base: {
      color: str(m.base?.color, legacyColor ?? baseColorDefault),
      metalness: num(m.base?.metalness, 0),
    },
    specular: { roughness: num(m.specular?.roughness, 0.3), ior: num(m.specular?.ior, 1.5) },
    coat: { weight: num(m.coat?.weight, 0), roughness: num(m.coat?.roughness, 0) },
    transmission: { weight: num(m.transmission?.weight, 0) },
    emission: {
      color: str(m.emission?.color, '#000000'),
      luminance: num(m.emission?.luminance, 0),
    },
    geometry: { opacity: num(m.geometry?.opacity, 1) },
    maps: {
      albedo: m.maps?.albedo ?? null,
      normal: m.maps?.normal ?? null,
      roughness: m.maps?.roughness ?? null,
      metalness: m.maps?.metalness ?? null,
      emissive: m.maps?.emissive ?? null,
      ao: m.maps?.ao ?? null,
    },
  };
  return m.unsupported ? { ...out, unsupported: m.unsupported } : out;
}
