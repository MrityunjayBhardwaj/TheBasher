// Navmesh — a traversable region used by WalkPath for path clamping.
//
// P2 Decision (2026-05-06): Navmesh sources from a hardcoded ground-plane
// primitive parameterised by half-extents + a list of axis-aligned obstacle
// boxes. Mesh-driven navmeshes (input: Mesh socket) ship in P3.
//
// Pure: same params → same navmesh value. The downstream `WalkPath` node
// performs clamping; the navmesh node itself is a data POJO. Cost is
// 'cheap' until P3 plumbs a real recast triangulation pass — at that point
// we lift to 'expensive' and consider a worker offload (THESIS.md §53).
//
// REF: THESIS.md §40 (Navmesh node), §33 (recast-navigation-js as MIT
//      navmesh impl — adopted in P3 once mesh-driven inputs land).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { NavmeshValue } from './types';

const HalfSize2 = z.tuple([z.number().positive(), z.number().positive()]);
const Center2 = z.tuple([z.number(), z.number()]);

export const NavmeshParams = z.object({
  /** Half-extents of the ground plane in [x, z] world units. */
  halfSize: HalfSize2.default([10, 10]),
  obstacles: z
    .array(
      z.object({
        center: Center2.default([0, 0]),
        halfSize: HalfSize2.default([1, 1]),
      }),
    )
    .default([]),
});
export type NavmeshParams = z.infer<typeof NavmeshParams>;

export const NavmeshNode: NodeDefinition<NavmeshParams, NavmeshValue> = {
  type: 'Navmesh',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NavmeshParams,
  inputs: {},
  outputs: { out: { type: 'Navmesh', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'Navmesh',
      halfSize: params.halfSize,
      obstacles: params.obstacles.map((o) => ({ center: o.center, halfSize: o.halfSize })),
    };
  },
};
