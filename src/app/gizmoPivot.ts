// #228 Slice C — pure pivot-point computation for the multi-object gizmo
// (Blender pivot_point/index.rst). Given the selected objects' WORLD origins and
// the active object's origin, return the point the gizmo seeds at and orbits/
// scales around:
//   - median       → average of all origins (Blender default)
//   - boundingBox   → centre of the origins' axis-aligned bounding box
//   - active        → the active (primary) object's origin
//   - individual    → display the gizmo at the median, but each object transforms
//                     about its OWN origin (the per-node application lives in the
//                     gizmo; for the SEED point we use the median here)
//   - cursor        → reserved (Basher has no 3D cursor) → falls back to median
//
// Pure + three-free (operates on number triples) so it unit-tests without a GPU.

import type { Pivot } from './stores/viewportStore';

type Vec3 = [number, number, number];

/** The gizmo's pivot point for `mode` over the selected world `origins`. The
 *  active origin is used only by `active`; `individual`/`cursor`/unknown fall
 *  back to the median (so the gizmo still displays at a sensible centre).
 *  Returns [0,0,0] for an empty selection. */
export function pivotPoint(
  mode: Pivot,
  origins: ReadonlyArray<Vec3>,
  activeOrigin: Vec3 | null,
): Vec3 {
  if (origins.length === 0) return [0, 0, 0];

  if (mode === 'active' && activeOrigin) return [activeOrigin[0], activeOrigin[1], activeOrigin[2]];

  if (mode === 'boundingBox') {
    const min: Vec3 = [origins[0][0], origins[0][1], origins[0][2]];
    const max: Vec3 = [origins[0][0], origins[0][1], origins[0][2]];
    for (const o of origins) {
      for (let i = 0; i < 3; i++) {
        if (o[i] < min[i]) min[i] = o[i];
        if (o[i] > max[i]) max[i] = o[i];
      }
    }
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }

  // median (also the fallback for individual / cursor / unknown)
  const sum: Vec3 = [0, 0, 0];
  for (const o of origins) {
    sum[0] += o[0];
    sum[1] += o[1];
    sum[2] += o[2];
  }
  const n = origins.length;
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}
