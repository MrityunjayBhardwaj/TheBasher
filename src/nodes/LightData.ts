// LightData — the DATA half of the object↔data split for the four POSABLE lights
// (#386, Stage C · C3).
//
// A light's substance is its SHADING — which kind it is (Directional/Point/Spot/
// Area), how bright, what colour, its falloff and aim. Where it sits in the world
// is a pose the Object owns. This node owns the shading half and DELIBERATELY no
// transform (position/rotation/scale live on the Object).
//
// It is the SECOND non-mesh member of the `ObjectData` union (after CurveData):
// like a curve it produces NO `MeshData` (a light is not render geometry). Unlike
// the four separate fused light NODES, LightData is ONE node with a `lightKind`
// discriminator — Blender models every light as ONE `Light` datablock with a
// `type` enum, so one union arm, one migration writer, one register entry, one
// inspector section. It evaluates to a discriminated `LightDataValue`; the shared
// `recomposeLightObject` (lightRecompose.ts) reconstitutes the flat `LightValue`
// the renderer's light band still consumes, at BOTH gathers (Scene + LightRig).
//
// AmbientLight is NOT here — ambient is a World datablock in Blender (only 4 light
// OBJECT types exist), so it stays a bare fused `AmbientLight` node with no pose.
//
// Coexists with the fused Directional/Point/Spot/AreaLight; nothing migrates in
// C3-Slice-1. Slice 2 adds the v5→v6 format migration, Slice 3 flips every
// producer, Slice 4 retires the four fused evaluates (the recompose already feeds
// the split through the existing light band).
//
// The ranges here are the SUPERSET across the four kinds (intensity max(100), not
// Directional's max(20)) so a migrated project's existing shading always re-parses
// (a collapsed max(20) would reject an `intensity:50` area light on load). Per-kind
// defaults are a convenience for NEW nodes only — the migration carries each kind's
// OWN default forward (Slice 2), it never relies on these collapsed ones.
//
// H14 hydrate seam: every param carries a zod default and `evaluate` re-guards with
// `?? default`, so a hand-authored or migrated param bag never yields an undefined
// shading field.
//
// REF: src/nodes/DirectionalLight.ts / PointLight.ts / SpotLight.ts / AreaLight.ts
//      (the fused per-kind nodes + their shading fields); src/nodes/lightRecompose.ts
//      (the flat-LightValue reconstruction); issue #386.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { LightDataValue } from './types';

export const LightDataParams = z.object({
  /** Which of the four posable light kinds this data half describes. The single
   *  discriminator that collapses the four fused light NODES into one node (one
   *  Light datablock with a type enum, Blender-style). */
  lightKind: z.enum(['Directional', 'Point', 'Spot', 'Area']).default('Point'),
  // Shading fields — the SUPERSET across the four kinds. A given lightKind reads
  // only the subset it owns (the recompose picks them per kind); the rest carry
  // their defaults harmlessly. Ranges are the widest across kinds (see file head).
  intensity: z.number().min(0).max(100).default(1),
  color: z.string().default('#ffffff'),
  distance: z.number().min(0).default(0),
  decay: z.number().min(0).default(2),
  angle: z
    .number()
    .min(0)
    .max(Math.PI / 2)
    .default(Math.PI / 6),
  penumbra: z.number().min(0).max(1).default(0.1),
  width: z.number().positive().default(2),
  height: z.number().positive().default(2),
  /** Spot aim point (authored shading orientation, not TRS — parity-first, #386). */
  target: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** Area aim point (same POSE-adjacent-but-shading-authoritative role as spot's target). */
  lookAt: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** #205 — optional HDR/EXR emitter texture (env-hdri assetRef) for a studio area light. */
  tex: z.string().optional(),
});
export type LightDataParams = z.infer<typeof LightDataParams>;

export const LightDataNode: NodeDefinition<LightDataParams, LightDataValue> = {
  type: 'LightData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LightDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // The DEFINING section — a light's substance is its shading. A data node owns no
  // pose, so no 'transform'/'constraint'/'driver' (those live on the Object).
  inspectorSections: ['light'],
  evaluate(params) {
    // H14 hydrate seam: re-guard every field with `?? default` so a migrated or
    // hand-authored param bag (which bypasses zod's default-fill) never yields
    // an undefined shading field.
    const light = params.lightKind ?? 'Point';
    return {
      kind: 'LightData',
      light,
      intensity: params.intensity ?? 1,
      color: params.color ?? '#ffffff',
      distance: params.distance ?? 0,
      decay: params.decay ?? 2,
      angle: params.angle ?? Math.PI / 6,
      penumbra: params.penumbra ?? 0.1,
      width: params.width ?? 2,
      height: params.height ?? 2,
      target: params.target ?? [0, 0, 0],
      lookAt: params.lookAt ?? [0, 0, 0],
      // Pass the emitter texture ref through unchanged. undefined → plain light.
      ...(params.tex ? { tex: params.tex } : {}),
    };
  },
};
