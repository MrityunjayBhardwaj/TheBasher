// AreaLight — rectangular light. Maps to THREE.RectAreaLight in the viewport.
// Pre-baked envMap support is out of scope for v0.5; the light samples
// directly via the standard RectAreaLightUniformsLib path.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { AreaLightValue } from './types';

export const AreaLightParams = z.object({
  intensity: z.number().min(0).max(100).default(5),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 5, 0]),
  color: z.string().default('#ffffff'),
  width: z.number().positive().default(2),
  height: z.number().positive().default(2),
  lookAt: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Euler XYZ. v1: helper visualization only — `lookAt` stays
  // authoritative for the rendered RectAreaLight orientation.
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Transform scale. AreaLight has a real geometric extent — width
  // and height — so scale.x multiplies width and scale.y multiplies
  // height when the RectAreaLight + helper render. Power scales
  // naturally with area (RectAreaLight intensity is luminance, cd/m²,
  // so total flux = intensity × width × height × scale.x × scale.y).
  // Bigger area = more light cast — matching the "size = power" rule
  // used on the other lights (volume product), but expressed through
  // geometry rather than an intensity multiplier (avoids double-count).
  // scale.z is preserved for round-trip but has no shading effect.
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
  // #205 — an OPTIONAL HDR/EXR emitter texture (an env-hdri assetRef, V47/V41
  // content-hash store). When set, this area light becomes a STUDIO LIGHT: the
  // renderer expands it into the §1.5 PAIR — a RectAreaLight tinted by the
  // texture's mean radiance (averageRadiance) + an emissive textured card (the
  // visible look + reflections). UNSET (the default) → a plain RectAreaLight,
  // byte-identical to a pre-#205 project (V37 parity; no migration needed since
  // optional means "absent" reads back as absent).
  tex: z.string().optional(),
});
export type AreaLightParams = z.infer<typeof AreaLightParams>;

export const AreaLightNode: NodeDefinition<AreaLightParams, AreaLightValue> = {
  type: 'AreaLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: AreaLightParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['transform', 'constraint', 'driver'],
  evaluate(params) {
    const rotation = params.rotation ?? ([0, 0, 0] as [number, number, number]);
    const scale = params.scale ?? ([1, 1, 1] as [number, number, number]);
    return {
      kind: 'AreaLight',
      intensity: params.intensity,
      position: params.position,
      rotation,
      scale,
      color: params.color,
      width: params.width,
      height: params.height,
      lookAt: params.lookAt,
      // Pass the emitter texture ref through unchanged. undefined → plain light.
      ...(params.tex ? { tex: params.tex } : {}),
    };
  },
};
