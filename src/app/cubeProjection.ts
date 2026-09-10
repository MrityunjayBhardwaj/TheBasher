// #994 / #786 — the cube projection's ARITHMETIC, with no road attached.
//
// ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────────────────
//
// #994 computed the layer on the READ road only, so it could live inside `uvProjection.ts`
// beside the minting. #786 gives the projection a real build arm, and the BUILD road needs the
// identical values: the buffer it materialises and the layer the store mints have to be the
// same numbers or the mesh draws one projection while the attribute system reports another —
// two spellings of one answer, which is the failure this repo keeps finding by name.
//
// So the arithmetic moved here, where it imports nothing from the registry and is therefore
// callable from both sides without a cycle. `uvProjection.ts` and `geometryRegistry.ts` are its
// only callers and neither owns it.
//
// REF: src/app/uvProjection.ts (the read road); src/app/geometryRegistry.ts (`buildUVProject`);
//      src/app/cornerMaterialisation.ts (what the build road does with the result);
//      issues #994, #786.

import type { BufferAttribute, BufferGeometry } from 'three';
import type { AttributeData } from '../nodes/attributes';

/** The six sides of the virtual cube, as (dominant axis, sign). */
export type CubeSide = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Which side of the cube a face projects onto — the reference's "closest and aligned
 * projector", with the six axis-aligned projectors a cube has.
 *
 * Ties (a normal exactly on a diagonal) resolve by the `>` comparisons below, i.e. to the
 * earliest axis. Deterministic rather than arbitrary: a tie must not depend on iteration order,
 * because two runs disagreeing about one face's side is a difference in the authored layer that
 * nothing downstream could explain.
 */
export function sideFor(nx: number, ny: number, nz: number): CubeSide {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  if (ax >= ay && ax >= az) return nx >= 0 ? 0 : 1;
  if (ay >= az) return ny >= 0 ? 2 : 3;
  return nz >= 0 ? 4 : 5;
}

/**
 * The two components a side reads, in the cube-map convention — +X reads (−z, y), −X reads
 * (z, y), and so on around the cube.
 *
 * The sign flips are what keep a face's UV winding consistent with its geometric winding. A
 * convention that ignored them projects three of the six sides mirrored, which draws a legible
 * picture of a wrong answer: text on the far side of a box reads backwards and nothing errors.
 */
export function uvForSide(
  side: CubeSide,
  x: number,
  y: number,
  z: number,
): readonly [number, number] {
  switch (side) {
    case 0:
      return [-z, y];
    case 1:
      return [z, y];
    case 2:
      return [x, -z];
    case 3:
      return [x, z];
    case 4:
      return [x, y];
    case 5:
      return [-x, y];
    default: {
      const unreachable: never = side;
      throw new Error(`uvForSide: undeclared cube side ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The corner-domain layer a cube projection authors over `geometry`'s rims.
 *
 * The normal is Newell's, not a cross product of the first three corners: an n-gon's first
 * three corners can be collinear (they are, on a bevel's chamfer quads at small amounts), and a
 * cross product there yields a zero vector whose dominant axis is whichever `sideFor`'s
 * comparisons happen to reach. Newell's sums over the whole rim, so it is stable on any polygon
 * that has an area at all.
 */
export function cubeProjectedLayer(
  geometry: BufferGeometry,
  polygons: readonly (readonly number[])[],
  size: number,
): AttributeData {
  const position = geometry.getAttribute('position') as BufferAttribute;
  const components = 2;
  let corners = 0;
  for (const rim of polygons) corners += rim.length;
  const data = new Float32Array(corners * components);
  let at = 0;
  for (const rim of polygons) {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let k = 0; k < rim.length; k++) {
      const a = rim[k];
      const b = rim[(k + 1) % rim.length];
      const ax = position.getX(a);
      const ay = position.getY(a);
      const az = position.getZ(a);
      const bx = position.getX(b);
      const by = position.getY(b);
      const bz = position.getZ(b);
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    // 🔑 CHOSEN ONCE PER FACE AND READ BY EVERY CORNER OF IT — this line, and only this line, is
    // what makes the output an authored corner layer rather than a lift. Hoisting the choice to
    // the vertex (projecting positions, as a planar map does) would make the value a function of
    // the render vertex again and the operator would qualify for nothing.
    const side = sideFor(nx, ny, nz);
    for (const vertex of rim) {
      const [u, v] = uvForSide(
        side,
        position.getX(vertex),
        position.getY(vertex),
        position.getZ(vertex),
      );
      data[at] = u / size + 0.5;
      data[at + 1] = v / size + 0.5;
      at += components;
    }
  }
  return { domain: 'corner', type: 'float2', count: corners, data };
}
