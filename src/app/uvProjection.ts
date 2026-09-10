// #994 — THE CUBE PROJECTION: the substrate's first producer of a corner-domain layer that is
// not a lift.
//
// ── WHAT THIS EXISTS TO MAKE POSSIBLE ─────────────────────────────────────────────────
//
// Four issues wait on one absence: nothing authors element data independently of the render
// buffer. The corner domain in particular has exactly one producer today — `readMeshUVs`, which
// GATHERS a per-vertex `uv` buffer through the polygon rims. That gather is a pullback along
// loop → vertex, so its value is constant on every fibre: two loops meeting at one render vertex
// read the same buffer slot and CANNOT disagree, on any mesh, however heavily shared ([[V449]]).
// A gate phrased as "wait until something authors a corner value that differs between two loops
// at one render vertex" is therefore unsatisfiable by any lift, and every candidate that had
// been named for it — an importer preserving a second UV set above all — turns out to be one.
//
// ── 🔴 WHY A CUBE AND NOT A PLANE ─────────────────────────────────────────────────────
//
// A planar projection maps position → UV through ONE axis for every face. Its value is a pure
// function of the corner's POSITION, and every loop at a shared render vertex reads the same
// position — so a planar projection agrees at every shared vertex by construction and is a third
// lift wearing an operator's clothes. It would ship green and author nothing.
//
// A cube projection chooses its side PER FACE, from that face's own normal, which is what the
// reference does and says:
//
//     Each face will choose the closest and aligned projector with its surface normal.
//       — manual/modeling/modifiers/modify/uv_project.rst
//
//     Projects each selected face onto the most suitable side of a virtual cube […]
//     The cube is centered on the pivot point and aligned to the mesh's local axes.
//       — manual/modeling/meshes/editing/uv.rst  (Cube Projection; *Cube Size* is `size`)
//
// So the value is a function of (face, corner) rather than of the vertex, and two faces with
// different dominant normals meeting at one render vertex land on different sides and write
// different UVs there. That difference IS the product.
//
// ⚠️ AND IT IS A CLAIM THE OPERATOR MUST BE MADE TO PROVE ABOUT ITSELF, not one this comment
// gets to assert. #994 states the falsification and `uvProjection.gate.test.ts` runs it: count
// the render vertices read by more than one loop, then count how many of those carry DIFFERING
// projected values. A zero second number means the projection quietly became another lift.
//
// ── WHY IT LIVES ON THE READ ROAD ─────────────────────────────────────────────────────
//
// The values are a function of built positions, and positions come out of the tessellation.
// `src/nodes/` cannot reach one — measured, 0 of 97 files there import `geometryRegistry` —
// which is the same boundary `uvAttributes.ts` states in prose. So this mints where
// `readMeshUVs` mints, off geometry the registry has already built, and is counted as `read`
// growth. Nothing here awaits: an unbuilt source answers `loading` and the next read finds it.
//
// REF: src/app/uvAttributes.ts (`readMeshUVs` — the lift this is deliberately not, and the
//      minting pattern this follows); src/app/builtRims.ts (`alignedSplitRims` — corner → split
//      vertex, the same walk both use); src/nodes/attributes.ts (`UV_PROJECT`, and why it is not
//      `UV_MAP`); src/nodes/types.ts (the `uvProject` descriptor, and why it is a descriptor);
//      issues #994, #786 (materialising the layer to the buffer), #881 (its carriage), #959.

import type { BufferGeometry, BufferAttribute } from 'three';
import { readGeometry } from './geometryRegistry';
import { alignedSplitRims } from './builtRims';
import { UV_PROJECT, type AttributeData } from '../nodes/attributes';
import { mintAttributes } from '../nodes/attributeKey';
import { insert } from './attributeStore';
import type { GeometryDescriptor, GeometryRef, UVAttributeVerdict } from '../nodes/types';

/** The six sides of the virtual cube, as (dominant axis, sign). */
type CubeSide = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Which side of the cube a face projects onto — the reference's "closest and aligned
 * projector", with the six axis-aligned projectors a cube has.
 *
 * Ties (a normal exactly on a diagonal) resolve by the `>` comparisons below, i.e. to the
 * earliest axis. Deterministic rather than arbitrary: a tie must not depend on iteration order,
 * because two runs disagreeing about one face's side is a difference in the authored layer that
 * nothing downstream could explain.
 */
function sideFor(nx: number, ny: number, nz: number): CubeSide {
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
function uvForSide(side: CubeSide, x: number, y: number, z: number): readonly [number, number] {
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
function projectedLayer(
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

/**
 * Project `ref`'s corners onto a virtual cube and mint the resulting layer.
 *
 * `ref` must carry a `uvProject` descriptor — the projection's parameters live there, which is
 * what makes the layer identifiable at all (see the descriptor's own note on why it could not
 * ride on an attribute key instead).
 *
 * Synchronous and total: every arm returns an answer that says what it is, matching
 * `readMeshUVs`'s contract, because the two are read off the same built geometry and a caller
 * holding both must not have to learn two absence vocabularies.
 */
export function projectMeshUVs(ref: GeometryRef): UVAttributeVerdict {
  const descriptor: GeometryDescriptor = ref.descriptor;
  if (descriptor.kind !== 'uvProject') {
    return {
      kind: 'not-derivable',
      why: `a cube projection is stated by a 'uvProject' descriptor and this handle carries a '${descriptor.kind}' — nothing here says which cube to project onto`,
    };
  }
  const result = readGeometry(ref);
  if (result.status !== 'ok') {
    // Propagated as the read's own word, never re-worded. `elsewhere` and `pending` are the
    // SOURCE's states — a projection resolves to its source's instance — and a caller that must
    // decide whether to wait needs the reason that decides it, not this module's paraphrase.
    return {
      kind: 'not-derivable',
      why: `the geometry under this projection reads '${result.status}' (${result.availability}), so there are no positions to project`,
    };
  }
  // The SOURCE's rims, which are this handle's rims: `polygonLayoutOf` delegates for this kind
  // precisely because the projection makes no copy and inherits its source's split numbering.
  const polygons = alignedSplitRims(ref, result.geometry);
  if (polygons === null) {
    return {
      kind: 'not-derivable',
      why: "this mesh's polygon rims could not be recovered from its built index, so there are no faces to choose a cube side per",
    };
  }
  const minted = mintAttributes({
    [UV_PROJECT]: projectedLayer(result.geometry, polygons, descriptor.size),
  });
  if (minted === null)
    return { kind: 'not-derivable', why: 'the projected corner layer would not mint' };
  insert(minted.key, minted.set, 'read');
  return { kind: 'resident', key: minted.key };
}
