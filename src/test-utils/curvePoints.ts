// Test helper: wrap bare control-point coordinates into id'd control points.
//
// After epic #453, a Curve's `points` param is `{id, co}[]`, not `Vec3[]`. Fixtures still want
// to author a curve as a list of coordinates; this stamps the `cp0, cp1, …` ids — the SAME
// vocabulary the schema default and the v1→v2 migration mint — so a fixture-built curve matches
// a real one and `curvePointsOf` (which returns the bare co's) round-trips the input.

import type { CurvePoint } from '../nodes/Curve';
import type { Vec3 } from '../nodes/types';

export function withIds(coords: readonly Vec3[]): CurvePoint[] {
  return coords.map((co, i) => ({ id: `cp${i}`, co }));
}
