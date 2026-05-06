// WalkPath — sample a navmesh-clamped path from `from` to `to`.
//
// Inputs:
//   - navmesh (Navmesh, single)
//
// Pure: same (params, inputs.navmesh) → same path. The path is computed
// deterministically — no recast WASM call yet. P3 swaps the inner sampler
// for recast; the surface contract (input → output) stays the same.
//
// P2 algorithm — straight-line sampling with axis-aligned-obstacle clamping:
//
//   1. Sample N evenly spaced points along the (from → to) segment in 2D
//      (xz plane; y stays at the navmesh ground level — P2 ground-plane).
//   2. For each sample, if it lies inside any obstacle, push it to the
//      nearest obstacle edge along the segment's normal direction.
//   3. Clamp every sample to the navmesh half-extents.
//
// This is enough for acceptance #3: a WalkPath whose end-point lies inside
// an obstacle is clamped to the navmesh boundary; resulting samples stay on
// the traversable area. Real path-finding (around obstacles) is P3.
//
// REF: THESIS.md §40, vyapti V2.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { NavmeshValue, Vec3, WalkPathValue } from './types';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const WalkPathParams = z.object({
  from: Vec3Schema.default([0, 0, 0]),
  to: Vec3Schema.default([0, 0, 0]),
  /** Number of samples along the path (>=2). */
  sampleCount: z.number().int().min(2).default(16),
});
export type WalkPathParams = z.infer<typeof WalkPathParams>;

function clampToHalfExtents(x: number, half: number): number {
  return Math.max(-half, Math.min(half, x));
}

function projectOutOfObstacle(
  x: number,
  z: number,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
): { x: number; z: number } {
  const dx = x - cx;
  const dz = z - cz;
  // Already outside? bail.
  if (Math.abs(dx) > hx || Math.abs(dz) > hz) return { x, z };
  // Push to the nearest face: the axis with smallest required displacement wins.
  const pushX = (dx >= 0 ? hx + 1e-4 : -hx - 1e-4) - dx;
  const pushZ = (dz >= 0 ? hz + 1e-4 : -hz - 1e-4) - dz;
  if (Math.abs(pushX) <= Math.abs(pushZ)) {
    return { x: x + pushX, z };
  }
  return { x, z: z + pushZ };
}

export const WalkPathNode: NodeDefinition<WalkPathParams, WalkPathValue> = {
  type: 'WalkPath',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: WalkPathParams,
  inputs: { navmesh: { type: 'Navmesh', cardinality: 'single' } },
  outputs: { out: { type: 'WalkPath', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs) {
    const navmesh = inputs.navmesh as NavmeshValue | undefined;
    const samples: Vec3[] = [];
    const N = params.sampleCount;
    let length = 0;
    let prev: Vec3 | null = null;

    for (let i = 0; i < N; i++) {
      const u = N > 1 ? i / (N - 1) : 0;
      let x = params.from[0] + (params.to[0] - params.from[0]) * u;
      const y = params.from[1] + (params.to[1] - params.from[1]) * u;
      let z = params.from[2] + (params.to[2] - params.from[2]) * u;
      if (navmesh) {
        // Push out of any obstacle (apply each in declaration order; for
        // axis-aligned non-overlapping obstacles a single pass is enough).
        for (const o of navmesh.obstacles) {
          const out = projectOutOfObstacle(
            x,
            z,
            o.center[0],
            o.center[1],
            o.halfSize[0],
            o.halfSize[1],
          );
          x = out.x;
          z = out.z;
        }
        x = clampToHalfExtents(x, navmesh.halfSize[0]);
        z = clampToHalfExtents(z, navmesh.halfSize[1]);
      }
      const s: Vec3 = [x, y, z];
      if (prev) {
        const dx = s[0] - prev[0];
        const dy = s[1] - prev[1];
        const dz = s[2] - prev[2];
        length += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      samples.push(s);
      prev = s;
    }

    return { kind: 'WalkPath', samples, length };
  },
};
