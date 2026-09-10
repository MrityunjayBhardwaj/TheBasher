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
// ── 🔑 #786 — THE ARITHMETIC IS SHARED WITH THE BUILD ROAD AND LIVES IN NEITHER ─────────
//
// `cubeProjectedLayer` moved to `cubeProjection.ts` when the projection got a build arm. The
// buffer `buildUVProject` materialises and the layer this mints have to be the same numbers; two
// spellings would let the mesh draw one projection while the attribute system reported another,
// with nothing to error. So both roads call one function and neither owns it.
//
// REF: src/app/cubeProjection.ts (the arithmetic); src/app/uvAttributes.ts (`readMeshUVs` — the
//      lift this is deliberately not, and the minting pattern this follows); src/app/builtRims.ts
//      (`alignedSplitRims` — corner → split vertex, the same walk both use);
//      src/app/cornerMaterialisation.ts (the split #786 needs); src/nodes/attributes.ts
//      (`UV_PROJECT`, and why it is not `UV_MAP`); src/nodes/types.ts (the `uvProject`
//      descriptor); issues #994, #786, #881 (its carriage), #959.

import { readGeometry } from './geometryRegistry';
import { alignedSplitRims } from './builtRims';
import { cubeProjectedLayer } from './cubeProjection';
import { UV_PROJECT } from '../nodes/attributes';
import { mintAttributes } from '../nodes/attributeKey';
import { insert } from './attributeStore';
import type { GeometryDescriptor, GeometryRef, UVAttributeVerdict } from '../nodes/types';

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
    // Propagated as the read's own word, never re-worded. `elsewhere` and `pending` still
    // originate at the SOURCE — since #786 a projection BUILDS, but it can only build once its
    // source has, so an unbuilt source is what any non-`ok` status here is reporting — and a
    // caller that must decide whether to wait needs the reason that decides it, not this
    // module's paraphrase.
    return {
      kind: 'not-derivable',
      why: `the geometry under this projection reads '${result.status}' (${result.availability}), so there are no positions to project`,
    };
  }
  // 🔴 THIS HANDLE'S OWN RIMS, AND SINCE #786 THAT IS NO LONGER THE SAME THING AS ITS SOURCE'S.
  // What stood here read *"the projection makes no copy and inherits its source's split
  // numbering"* — true while it built nothing. It now builds a SPLIT buffer, so its split
  // numbering is its own and these rims are recovered from its own index. `polygonLayoutOf` still
  // delegates to the source, correctly, because that answers at the TOPOLOGICAL domain, which the
  // split does not touch: same faces, same rims, more slots to hold them in.
  const polygons = alignedSplitRims(ref, result.geometry);
  if (polygons === null) {
    return {
      kind: 'not-derivable',
      why: "this mesh's polygon rims could not be recovered from its built index, so there are no faces to choose a cube side per",
    };
  }
  const minted = mintAttributes({
    [UV_PROJECT]: cubeProjectedLayer(result.geometry, polygons, descriptor.size),
  });
  if (minted === null)
    return { kind: 'not-derivable', why: 'the projected corner layer would not mint' };
  insert(minted.key, minted.set, 'read');
  return { kind: 'resident', key: minted.key };
}
