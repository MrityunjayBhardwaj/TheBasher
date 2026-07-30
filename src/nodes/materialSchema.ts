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
//   • MIGRATED boxes (migrations[2]) get 0.5 — the roughness the pre-#178 renderer
//     gave a material with no override — so a saved project renders
//     BYTE-IDENTICALLY after the widen. Two deliberate defaults.
//
// REF: CONTEXT D-02/D-03 + HARD CONSTRAINTS (V10/H14); PLAN W1 (1.2/1.3/1.4);
//      vyapti V10/V32; hetvabhasa H14; issue #178.

import { z } from 'zod';
import type { BakedMaterialSpec, InlineMaterialSpec } from './types';

/**
 * The roughness a pre-#178 material rendered at when no override was present.
 *
 * A FROZEN HISTORICAL CONSTANT, not a live mirror of anything. It used to be a
 * hand-copy of `SceneFromDAG.applyOverride`'s no-override branch; #394 S3b deleted
 * that branch — measured UNREACHABLE (its only call site was guarded by
 * `override ?`, and `BakedMeshR` had grown its own no-override arm) — so the thing
 * this once tracked no longer exists. It stays because a v2 save migrated at any
 * future date must still land on the look it had when it was saved.
 */
export const CURRENT_LOOK_ROUGHNESS = 0.5;

/**
 * THE standard base colour — the one every new material starts at (#394 D7).
 *
 * 0.8 linear grey: OpenPBR Surface v1.1.1's own `base_color` default, which is
 * also what Blender's startup material carries and what the glTF import path
 * already seeded. It is the spec's answer, not a taste call.
 *
 * There is deliberately NO per-node override of this. Blender was measured:
 * `primitive_cube_add` and `primitive_uv_sphere_add` produce IDENTICAL material
 * state (`data.materials == []`, `slot_count == 0`) — no reference gives a
 * primitive a special material, and the material-less look is theme-level.
 * `openpbrMaterialSchema` therefore takes no colour argument: with no seam to
 * thread a per-caller colour through, a new node CANNOT mint a special material.
 * The signature is the gate — there is nothing else to enforce.
 */
export const STANDARD_BASE_COLOR = '#cccccc';

// A persisted texture handle (mirrors BakedTextureRef in types.ts). Map slots are
// null until W5 attaches an image.
const bakedTextureRefSchema = z.object({
  hash: z.string(),
  colorSpace: z.enum(['srgb', 'srgb-linear', 'no-colorspace']),
  flipY: z.boolean(),
  wrapS: z.number(),
  wrapT: z.number(),
  // glTF direct-import captured-descriptor fields (texture-maps milestone). Both
  // OPTIONAL so a native baked ref / pre-milestone save re-parses unchanged
  // (V10/H14). zod strips unknown keys, so they MUST be declared here or a whole-
  // params setParam re-parse would silently drop a captured descriptor's identity.
  gltfTexture: z.number().optional(),
  gltfTexCoord: z.number().optional(),
});
const mapSlot = bakedTextureRefSchema.nullable().default(null);
// Exported so the glTF→OpenPBR converter (gltfMaterialToOpenpbr) seeds an IR with
// the SAME empty-maps / identity-UV defaults the schema uses — one source, no drift.
export const NULL_MAPS = {
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

// v0.6 #3 (#181) — the ONE shared UV placement (tiling/offset/rotation). IDENTITY
// default so a pre-#3 project renders byte-identically (V10/H14). Every field +
// the object carry a `.default` so a partial setParam whole-params re-parse refills
// siblings (R6 — same discipline as the lobes).
export const IDENTITY_UV_TRANSFORM = {
  tiling: [1, 1] as [number, number],
  offset: [0, 0] as [number, number],
  rotation: 0,
};
const uvTransformSchema = z
  .object({
    tiling: z.tuple([z.number(), z.number()]).default([1, 1]),
    offset: z.tuple([z.number(), z.number()]).default([0, 0]),
    rotation: z.number().default(0),
  })
  .default({ ...IDENTITY_UV_TRANSFORM });

/**
 * The OpenPBR core-10 inline-material zod schema (layer 1 — NEW-node defaults).
 * Every field AND every nested object carries a `.default` so a partial `setParam`
 * whole-params re-parse (ops.ts) always fills siblings (R6).
 *
 * TAKES NO ARGUMENT ON PURPOSE (#394 D7). It used to take a `baseColorDefault` that
 * differed per primitive (box green, sphere blue) — that parameter WAS the whole
 * special-material mechanism; every other lobe was already standardized. See
 * `STANDARD_BASE_COLOR` for why one standard material is the reference's answer.
 */
export function openpbrMaterialSchema() {
  return z
    .object({
      name: z.string().default('default'),
      base: z
        .object({
          color: z.string().default(STANDARD_BASE_COLOR),
          metalness: z.number().default(0),
        })
        .default({ color: STANDARD_BASE_COLOR, metalness: 0 }),
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
          // glTF direct-import (texture-maps milestone) — OPTIONAL so a native
          // box/sphere + pre-milestone save re-parse unchanged (V10/H14).
          alphaCutoff: z.number().optional(),
          vertexColors: z.boolean().optional(),
          doubleSided: z.boolean().optional(),
        })
        .default({ opacity: 1 }),
      maps: mapsSchema,
      uvTransform: uvTransformSchema,
      unsupported: z.record(z.string(), z.number()).optional(),
    })
    .default({});
}

/**
 * Migrate a v2 inline material `{name,color}` → the v3 OpenPBR IR, seeding the
 * scalars to the CURRENT rendered look (R1 — roughness 0.5, NOT the OpenPBR 0.3),
 * so a saved project renders byte-identically. `base.color` is preserved from the
 * old `color`. THIS IS DELIBERATELY DIFFERENT from the zod NEW-node defaults.
 *
 * The colour fallback (#394 D7) is the standard, and it is reached ONLY by a v2 save
 * whose flat material carried no `color` at all — measured to be zero in-repo. Such a
 * save moves from its primitive's old special colour to the standard grey; every save
 * that recorded a colour (which is all of them, because `addNode` writes the parsed
 * defaults into params) is preserved untouched.
 */
export function migrateInlineMaterialV2toV3(oldMaterial: unknown): InlineMaterialSpec {
  const m = (oldMaterial ?? {}) as { name?: unknown; color?: unknown };
  return {
    name: typeof m.name === 'string' ? m.name : 'default',
    base: { color: typeof m.color === 'string' ? m.color : STANDARD_BASE_COLOR, metalness: 0 },
    specular: { roughness: CURRENT_LOOK_ROUGHNESS, ior: 1.5 }, // R1: current look, not 0.3
    coat: { weight: 0, roughness: 0 },
    transmission: { weight: 0 },
    emission: { color: '#000000', luminance: 0 },
    geometry: { opacity: 1 },
    maps: { ...NULL_MAPS },
    uvTransform: { ...IDENTITY_UV_TRANSFORM }, // v0.6 #3 — identity (no placement)
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
function vec2(v: unknown, fallback: [number, number]): [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : fallback;
}

/**
 * The evaluator/consumer hydrate guard (layer 3 — `?? default`). The hydrate seam
 * bypasses zod (in-memory state surgery / agent ops / fixtures), so read every
 * field with a default. DUAL-ACCEPT (CAVEAT-1): a legacy top-level `color`
 * (a pre-migration in-memory `{name,color}`) is accepted as `base.color`, so a
 * mid-migration material never silently drops to a wrong look. Always returns a
 * COMPLETE IR.
 *
 * `baseColorDefault` defaults to the standard (#394 D7) — a node hydrating its own
 * material param must NOT pass one. It stays an argument only for the callers whose
 * fallback is a DIFFERENT concern from "a new material's colour": the renderer's
 * missing-material grey and test fixtures that need a trap colour.
 */
export function hydrateInlineMaterial(
  raw: unknown,
  baseColorDefault: string = STANDARD_BASE_COLOR,
): InlineMaterialSpec {
  const m = (raw ?? {}) as {
    name?: unknown;
    color?: unknown; // legacy top-level (pre-migration)
    base?: PartialLobe;
    specular?: PartialLobe;
    coat?: PartialLobe;
    transmission?: PartialLobe;
    emission?: PartialLobe;
    geometry?: PartialLobe & {
      alphaCutoff?: unknown;
      vertexColors?: unknown;
      doubleSided?: unknown;
    };
    maps?: Partial<InlineMaterialSpec['maps']>;
    uvTransform?: { tiling?: unknown; offset?: unknown; rotation?: unknown };
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
    geometry: {
      opacity: num(m.geometry?.opacity, 1),
      // OPTIONAL captured-import fields — only present them when set, so a native
      // material's geometry lobe stays `{opacity}` (no spurious keys, V10/H14).
      ...(typeof m.geometry?.alphaCutoff === 'number'
        ? { alphaCutoff: m.geometry.alphaCutoff }
        : {}),
      ...(typeof m.geometry?.vertexColors === 'boolean'
        ? { vertexColors: m.geometry.vertexColors }
        : {}),
      ...(typeof m.geometry?.doubleSided === 'boolean'
        ? { doubleSided: m.geometry.doubleSided }
        : {}),
    },
    maps: {
      albedo: m.maps?.albedo ?? null,
      normal: m.maps?.normal ?? null,
      roughness: m.maps?.roughness ?? null,
      metalness: m.maps?.metalness ?? null,
      emissive: m.maps?.emissive ?? null,
      ao: m.maps?.ao ?? null,
    },
    uvTransform: {
      tiling: vec2(m.uvTransform?.tiling, [1, 1]),
      offset: vec2(m.uvTransform?.offset, [0, 0]),
      rotation: num(m.uvTransform?.rotation, 0),
    },
  };
  return m.unsupported ? { ...out, unsupported: m.unsupported } : out;
}

/**
 * The ONE discriminator between the two material specs a mesh value can carry.
 * `BakedMaterialSpec` is the rich captured-from-glTF spec (tagged by its
 * `materialClass`); `InlineMaterialSpec` is the authored OpenPBR IR, which has no
 * such tag. Shared so the read road (`resolveEvaluatedMesh`) and the modifier road
 * (`modifierGeometry`) narrow a `MeshData` material the SAME way — two spellings
 * of one rule is exactly the drift [[V101]] warns about.
 */
export function isBakedMaterialSpec(v: unknown): v is BakedMaterialSpec {
  if (typeof v !== 'object' || v === null) return false;
  return typeof (v as { materialClass?: unknown }).materialClass === 'string';
}
