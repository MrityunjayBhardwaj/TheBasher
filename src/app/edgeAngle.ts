// edgeAngle — a face's WINDING normal, and an edge's angle between the two faces meeting at it.
// Derived, never stored (#800).
//
// ── WHAT THIS IS FOR, AND WHY IT IS NOT #783 ─────────────────────────────────────────────
//
// #783 holds edge ATTRIBUTES — storage for a value some operator writes and a later one reads,
// with the promotion rule that storage needs. An edge angle is not that. It is a function of the
// topology and the positions, recomputable from them at any time, so it needs no table, no
// promotion rule and no format decision. That is the whole reason it can ship first: it gives an
// attribute expression something true to read while #783 keeps waiting for its first writer.
//
// ── THE DEFINITION IS BLENDER'S, AND IT IS NOT THE INTERIOR DIHEDRAL ─────────────────────
//
// Blender's Edge Angle node: *"The shortest angle in radians between two faces where they meet at
// an edge. The range of the data is from zero to PI. Flat edges and Non-manifold edges have an
// angle of zero. An edge between two faces completely folded back on each other has an angle of
// PI"* (`manual/modeling/geometry_nodes/mesh/read/edge_angle.rst`).
//
// So it is the DEVIATION FROM FLAT — `acos(n0 · n1)` on the two outward normals — and not the
// interior dihedral, which runs the other way (flat is π there, a box edge is π/2 in both, and
// the two coincide on a box, which is why a box is worthless as evidence about which one this
// is). The discriminating shape is a sphere: under this definition a finer sphere is FLATTER and
// its angles fall toward zero, where an interior dihedral would climb toward π. Measured, and
// pinned as the gate's discriminating row — max angle 43.61° / 22.80° / 11.30° / 5.63° at 8x6 /
// 16x8 / 32x16 / 64x32, halving as the segment count doubles.
//
// 🔴 UNSIGNED ONLY. Blender also ships a SIGNED angle, whose sign distinguishes concave from
// convex. It is not implemented here and is deferred by name rather than overlooked: the sign
// needs a convexity test against the edge's own direction, and the consumer this was built for —
// a scope reading *"edges where the angle exceeds 30°"* — cannot express a sign. When something
// needs it, it is a second reading of these same two normals, not a second traversal.
//
// REF: src/app/edgeIdentity.ts (`edgeFaceAdjacencyOf` — the walk, and the manifoldness);
//      src/app/builtRims.ts (`alignedSplitRims` — the split rims these normals are taken over);
//      src/app/rayMesh.ts (`faceNormalToward` — the OTHER face normal, and not this one);
//      manual/modeling/geometry_nodes/mesh/read/edge_angle.rst; issues #800, #783.

import type { BufferGeometry } from 'three';
import type { GeometryRef, Vec3 } from '../nodes/types';
import { alignedSplitRims } from './builtRims';
import { edgeFaceAdjacencyOf } from './edgeIdentity';
import { newellNormal } from './polygonInterpolation';

/**
 * Every face's unit normal, oriented by its rim's WINDING, or `null` per face for a rim with no
 * area (degenerate or collinear). `null` for the whole geometry when the rims cannot be recovered.
 *
 * ── 🔴 THIS IS NOT `faceNormalToward`, AND THE DIFFERENCE IS THE ENTIRE POINT ─────────────
 *
 * `rayMesh.faceNormalToward` flips its result toward the query point *"regardless of triangle
 * winding"* — deliberately, because a ray hit wants a normal facing the ray whichever way the
 * triangle happens to be wound. That makes it exactly unusable here: an angle BETWEEN two faces
 * is only meaningful if both normals were oriented by the same rule, and "toward the camera" is
 * not such a rule. Two names, two behaviours, and the reason they cannot be merged.
 *
 * ── WHY NEWELL RATHER THAN ONE CROSS PRODUCT ─────────────────────────────────────────────
 *
 * A face is an n-gon since #770, and a quad in a built mesh is not guaranteed planar — a sphere's
 * are not. A cross product of two rim edges answers for one corner and silently picks a diagonal;
 * Newell's sum is the area-weighted normal of the whole rim, which degrades gracefully on a
 * non-planar face and reduces to the same answer on a planar one. It also needs no triangulation,
 * so it does not re-import the fan assumption `builtRims` was written to avoid.
 */
export function builtFaceNormals(
  ref: GeometryRef,
  geometry: BufferGeometry,
): readonly (Vec3 | null)[] | null {
  const rims = alignedSplitRims(ref, geometry);
  if (rims === null) return null;
  const position = geometry.getAttribute('position');
  if (position === undefined) return null;

  // 🔴 THE SUM ITSELF MOVED TO `polygonInterpolation` AT #825, AND THE POINT IS THAT THERE IS NOW
  // ONE OF IT. That module needs the same normal to build the plane it projects a source face
  // into, so the loop that used to sit here would have had a second spelling — and the drift
  // would have been invisible, because both would return a plausible unit vector and only the
  // interpolation would quietly disagree with the edge angle about which way a face points. Same
  // reasoning as `reversedCornerAt`, extracted one domain over for the same reason (#785 is what
  // its missing second spelling cost).
  //
  // What stays HERE is the part that is this module's own: the `null` for a rim with no area.
  // Inventing a direction (say `[0,0,1]`) would make that face's edges report a definite angle
  // against their neighbours; `null` propagates to an angle of zero, which is the answer Blender
  // gives an edge it cannot orient.
  let longest = 0;
  for (const rim of rims) if (rim.length > longest) longest = rim.length;
  const coords = new Float64Array(longest * 3);
  const normal = new Float64Array(3);

  const normals: (Vec3 | null)[] = [];
  for (const rim of rims) {
    for (let i = 0; i < rim.length; i++) {
      coords[i * 3] = position.getX(rim[i]);
      coords[i * 3 + 1] = position.getY(rim[i]);
      coords[i * 3 + 2] = position.getZ(rim[i]);
    }
    normals.push(
      newellNormal(coords, rim.length, normal) ? [normal[0], normal[1], normal[2]] : null,
    );
  }
  return normals;
}

/**
 * Every edge's angle in radians, index-aligned with {@link edgeSetOf}'s pairs — `0` to `PI`.
 *
 * `null` for exactly the descriptors the edge walk refuses (`gltf` and `baked` anywhere up the
 * chain, whose buffers live outside the descriptor) or whose split rims cannot be recovered.
 *
 * ⚠️ ZERO IS AN ANSWER AND NOT AN ABSENCE, which matters because three different edges give it:
 * a FLAT edge (its two faces are coplanar), a BOUNDARY edge (one face — every open mesh has
 * them, and every `subset` produces them), and a NON-MANIFOLD edge (three or more). Blender
 * collapses all three to zero and this follows it rather than inventing a fourth answer. A
 * consumer that must tell them apart reads {@link edgeFaceAdjacencyOf}'s entry length, which is
 * why that is exported beside this rather than hidden inside it.
 *
 * 🔴 A `Float32Array` and not `number[]`: this is one value per edge and an Array x8 of a 64x32
 * sphere is 32,256 of them. Same reasoning as `EdgeSet.pairs`, which is a `Uint32Array` for the
 * same shape of answer at the same scale.
 */
export function edgeAnglesOf(ref: GeometryRef, geometry: BufferGeometry): Float32Array | null {
  const adjacency = edgeFaceAdjacencyOf(ref.descriptor);
  const normals = builtFaceNormals(ref, geometry);
  if (adjacency === null || normals === null) return null;

  // 🔴 NO LENGTH GUARD HERE, AND THE REASON IS WORTH THE LINES BECAUSE TWO DRAFTS GOT IT WRONG.
  // The first guarded each lookup with `=== undefined`, which cannot fire — `noUncheckedIndexedAccess`
  // is off, so indexing a `(Vec3 | null)[]` yields `Vec3 | null` and never `undefined`. The second
  // replaced it with `normals.length !== adjacency.faces.length`, which compares a FACE count to an
  // EDGE count and refuses every real mesh.
  //
  // What actually holds is structural: `builtFaceNormals` is one entry per rim of
  // `alignedSplitRims`, which refuses unless its rim count equals `weldedPolygonsOf`'s, and the
  // adjacency's face indices are positions in that same rim array. So a face index is in range by
  // construction, and the only lookup that can fail is a rim with no area — which is a `null`
  // normal, checked below and answered with Blender's zero.
  const angles = new Float32Array(adjacency.faces.length);
  for (let e = 0; e < adjacency.faces.length; e++) {
    const faces = adjacency.faces[e];
    if (faces.length !== 2) continue;
    const a = normals[faces[0]];
    const b = normals[faces[1]];
    if (a === null || b === null) continue;
    // Clamped before `acos` because a dot of two unit vectors can land a few ulps outside
    // [-1, 1] in floating point, and `Math.acos(1.0000000000000002)` is NaN — which would
    // propagate silently through any comparison a scope expression made against it.
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    angles[e] = Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
  }
  return angles;
}
