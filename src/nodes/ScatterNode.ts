// ScatterNode — proves the procedural-as-substrate pattern (THESIS.md §29).
//
// Inputs: a list of Mesh assets (any SceneChild type — BoxMesh, GltfAsset,
// Group, etc.). One asset is chosen per instance via the seeded PRNG.
// Output: a `Scatter` value carrying the per-instance transforms + the
// asset list. The viewport renders one node per instance, indexing back
// into `assets`.
//
// Determinism (V2): same (params, inputs) → same instance list, byte-exact.
// Twice-eval test enforces this (`nodes.test.ts`). N capped at 5000 in v0.5
// (THESIS.md §53). Worker offload arrives in v0.6.
//
// REF: THESIS.md §29, §39, §48, §53.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ScatterInstance, ScatterValue, SceneChild, Vec3 } from './types';
import { mulberry32 } from './random';

export const SCATTER_MAX = 5000;

export const ScatterNodeParams = z.object({
  /** Number of instances to place. Hard-capped at SCATTER_MAX (5000) in v0.5. */
  density: z.number().int().min(0).max(SCATTER_MAX).default(50),
  /** mulberry32 seed. Same seed → same placement across runs. */
  seed: z.number().int().default(42),
  /** Half-extents of the axis-aligned box the points are scattered within. */
  bounds: z
    .tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()])
    .default([5, 0, 5]),
  /** Random scale jitter range (per axis), uniform in [1-jitter, 1+jitter]. */
  scaleJitter: z.number().min(0).max(1).default(0.2),
  /** Random Y-rotation range in radians, uniform in [0, 2π) when true. */
  randomYaw: z.boolean().default(true),
});
export type ScatterNodeParams = z.infer<typeof ScatterNodeParams>;

export const ScatterNode: NodeDefinition<ScatterNodeParams, ScatterValue> = {
  type: 'Scatter',
  version: 1,
  pure: true,
  cost: 'medium',
  paramSchema: ScatterNodeParams,
  inputs: { assets: { type: 'SceneObject', cardinality: 'list' } },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['mesh', 'transform', 'material'],
  evaluate(params, inputs) {
    const assets = (inputs.assets as SceneChild[] | undefined) ?? [];
    const count = Math.min(params.density, SCATTER_MAX);
    if (count === 0 || assets.length === 0) {
      return { kind: 'Scatter', seed: params.seed, count: 0, instances: [], assets };
    }
    const rng = mulberry32(params.seed);
    const [hx, hy, hz] = params.bounds;
    const jitter = params.scaleJitter;
    const TWO_PI = Math.PI * 2;
    const instances: ScatterInstance[] = [];
    for (let i = 0; i < count; i++) {
      // Sample order is stable: position(x,y,z) → yaw → scale → asset.
      const x = hx === 0 ? 0 : (rng() * 2 - 1) * hx;
      const y = hy === 0 ? 0 : (rng() * 2 - 1) * hy;
      const z = hz === 0 ? 0 : (rng() * 2 - 1) * hz;
      const yaw = params.randomYaw ? rng() * TWO_PI : 0;
      const s = jitter === 0 ? 1 : 1 - jitter + rng() * (2 * jitter);
      const assetIndex = Math.floor(rng() * assets.length) % assets.length;
      const position: Vec3 = [x, y, z];
      const rotation: Vec3 = [0, yaw, 0];
      const scale: Vec3 = [s, s, s];
      instances.push({ position, rotation, scale, assetIndex });
    }
    return {
      kind: 'Scatter',
      seed: params.seed,
      count: instances.length,
      instances,
      assets,
    };
  },
};
