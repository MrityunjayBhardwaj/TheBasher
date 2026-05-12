import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { DirectionalLightValue } from './types';

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

export const DirectionalLightNode: NodeDefinition<DirectionalLightParams, DirectionalLightValue> = {
  type: 'DirectionalLight',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: DirectionalLightParams,
  inputs: {},
  outputs: { out: { type: 'Light', cardinality: 'single' } },
  inspectorSections: ['transform'],
  evaluate(params) {
    // Defensive default for rotation — projects saved before the
    // rotation field existed land with `undefined` here because the
    // hydrate seam bypasses zod's .default() fill. The schema-level
    // default still works for new addNode ops (zod parses); this guard
    // covers the load-old-project path.
    const rotation = params.rotation ?? ([0, 0, 0] as [number, number, number]);
    const scale = params.scale ?? ([1, 1, 1] as [number, number, number]);
    return {
      kind: 'DirectionalLight',
      intensity: params.intensity,
      position: params.position,
      rotation,
      scale,
      color: params.color,
    };
  },
};
