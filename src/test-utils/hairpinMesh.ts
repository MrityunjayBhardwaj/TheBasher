// A stored tube bent back on itself like a hairpin, for tests of skin weights (#1356): up one leg,
// over the top, and down the other, the two legs a hair apart. A finger beside a finger, joined at
// the knuckles.

import type { MeshGeometryData } from '../nodes/types';
import { cylinderMesh } from './cylinderMesh';

export interface HairpinShape {
  /** The tube's radius. */
  readonly radius: number;
  /** Half the distance between the two legs' centre lines: a little over `radius`. */
  readonly half: number;
  /** How tall each straight leg is, from y = 0. */
  readonly leg: number;
  readonly radial: number;
  readonly rings: number;
}

/** How long the hairpin's centre line is: two legs and the half circle joining them. */
export function hairpinLength(shape: HairpinShape): number {
  return 2 * shape.leg + Math.PI * shape.half;
}

/**
 * The hairpin, in the XY plane: its first leg stands at x = −`half`, its second at x = +`half`.
 * Point `ring * radial + side` is on ring `ring` counted along the tube from the foot of the first
 * leg; side 0 of a leg's ring is the point FACING the other leg.
 */
export function hairpinMesh(shape: HairpinShape): MeshGeometryData {
  const { half, leg } = shape;
  const length = hairpinLength(shape);
  const straight = cylinderMesh({ ...shape, height: length });
  const points = new Float32Array(straight.points.length);
  for (let p = 0; p < points.length / 3; p++) {
    const across = straight.points[p * 3];
    const along = straight.points[p * 3 + 1];
    // The centre line at `along`, and the way across the hairpin's own plane there.
    let cx: number;
    let cy: number;
    let nx: number;
    let ny: number;
    if (along <= leg) [cx, cy, nx, ny] = [-half, along, 1, 0];
    else if (along >= leg + Math.PI * half) [cx, cy, nx, ny] = [half, length - along, -1, 0];
    else {
      const turn = Math.PI - (along - leg) / half;
      [cx, cy] = [half * Math.cos(turn), leg + half * Math.sin(turn)];
      [nx, ny] = [-Math.cos(turn), -Math.sin(turn)];
    }
    points.set([cx + across * nx, cy + across * ny, straight.points[p * 3 + 2]], p * 3);
  }
  return { ...straight, points };
}
