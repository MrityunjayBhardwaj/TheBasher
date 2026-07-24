import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';

export const DirectionalLightParams = z.object({
  intensity: z.number().min(0).max(20),
  position: z.tuple([z.number(), z.number(), z.number()]),
  // Euler XYZ rotation. When zero, the renderer falls back to "shine
  // toward the origin from `position`" (legacy seed behavior). When
  // non-zero, direction is computed as `rotation × (0,-1,0)` — the sun
  // points along its local -Y, rotated.
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Transform scale. Drives intensity at render time via the volume
  // product (sx*sy*sz) — bigger gizmo = brighter sun. Helper group also
  // scales by this so the visual matches the gesture. Defaults to
  // [1,1,1]; defensive default in evaluator + every consumer for
  // legacy projects (H14: hydrate seam bypasses zod's default-fill).
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
  color: z.string().default('#ffffff'),
});
export type DirectionalLightParams = z.infer<typeof DirectionalLightParams>;

export const DirectionalLightNode: NodeDefinition<DirectionalLightParams, never> = {
  type: 'DirectionalLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: DirectionalLightParams,
  inputs: {},
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['transform', 'constraint', 'driver'],
  // Retired (#386 S4): a DirectionalLight is now an Object → LightData, so no fused value
  // carries it any longer. This node stays registered SOLELY so the load-migration
  // (migrateFusedLightToSplit) can normalize an old fused light through its OWN version
  // ladder before splitting it. It never evaluates. The DirectionalLightValue interface
  // stays in types.ts — it is the RECOMPOSITION TARGET the renderer still consumes.
  evaluate(): never {
    throw new Error(
      'DirectionalLight is retired; projects migrate to Object+LightData on load (#386)',
    );
  },
};
