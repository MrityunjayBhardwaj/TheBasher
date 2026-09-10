// #786 — MATERIALISE AN AUTHORED CORNER LAYER TO THE RENDER BUFFER, splitting the vertices that
// have to be split for it to be representable at all.
//
// ── THE DIRECTION, AND WHY IT IS NOT THE INVERSE OF THE LIFT ──────────────────────────────
//
// `uvAttributes.ts` goes render buffer → loops: loop `k` of face `f` reads split vertex
// `rim[k]`. That is a pullback and it is total. Going back is MANY-TO-ONE — measured, on the
// shapes this repo builds:
//
//     box          24 loops → 24 split vertices        (equal, the coincidence that hid this)
//     sphere 8x6  176 loops → 63 split vertices
//     sphere 32x16 1984 loops → 561 split vertices
//
// 176 values cannot land in 63 slots unless the loops meeting at one vertex AGREE. A UV seam is
// exactly two faces disagreeing at one point, so disagreement is not an edge case — it is the
// entire reason the corner domain exists. Where they disagree the vertex is DUPLICATED and the
// index rewritten to send each face at its own copy.
//
// ── WHAT THE SPLIT COSTS, MEASURED RATHER THAN ASSERTED ───────────────────────────────────
//
// The risk #786 names is that this changes built vertex counts, and `pointCountMismatch`
// compares descriptor arithmetic against a POSITION WELD — two questions in different units. It
// does not fire, and the reason is structural rather than lucky: a duplicate is written AT THE
// POSITION OF THE VERTEX IT COPIES, so `weldByPosition` fuses the copies back and reads the same
// number it read before. Measured under a cube projection:
//
//     subject        positions before → after   duplicates   weld before → after   descriptor
//     box                     24 → 24                0             8 → 8               8
//     sphere 8x6              63 → 93               30            42 → 42              42
//     sphere 32x16           561 → 669              108           482 → 482            482
//
// A box needs zero duplicates, so its buffer comes out unchanged — which is the control that
// says the split fires on disagreement and not on being called.
//
// ── 🔴 THE WHOLE POSITION BUFFER IS COPIED, NOT THE PART THE RIMS REACH ───────────────────
//
// A sphere's built buffer holds positions NO RIM NAMES — 63 against 61 reached at 8x6, 561
// against 559 at 32x16, both times exactly two, three.js's degenerate pole vertices. A rebuild
// that wrote only the corners it walked would drop them silently and shift every index after
// them. So the source buffer is copied WHOLE and duplicates are appended after it: an unreached
// position keeps its index and its value, and carries a zeroed layer value it is never read for.
//
// ── WHY EXACT EQUALITY AND NOT A TOLERANCE ────────────────────────────────────────────────
//
// Grouping corner values by a tolerance is ORDER-DEPENDENT — which value becomes the group's
// representative depends on which corner the walk reached first, so two runs could split the
// same mesh differently. The values here are float32 read back from a `Float32Array`, and two
// loops that agree agree BITWISE because they are the same arithmetic over the same inputs. So
// equality is exact, the split is a deterministic function of the layer, and no tolerance has to
// be chosen or defended.
//
// REF: src/app/uvAttributes.ts (the lift — the other direction); src/app/builtRims.ts
//      (`alignedSplitRims` — corner → split vertex); src/app/pointIdentity.ts
//      (`pointCountMismatch` — the parity this is measured against);
//      src/app/geometryRegistry.ts (`buildUVProject` — the only caller); issues #786, #776, #994.

import { BufferAttribute, BufferGeometry } from 'three';
import type { PolygonRim } from './polygonLayout';
import { faceElementStarts } from './faceCount';
import type { AttributeData } from '../nodes/attributes';

/** What the materialisation produced, or the named reason it could not. */
export type MaterialisedLayer =
  | {
      readonly kind: 'materialised';
      readonly geometry: BufferGeometry;
      readonly duplicates: number;
    }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * `source` with `layer` written onto attribute `name`, splitting every render vertex whose loops
 * disagree.
 *
 * `arity` and `rims` describe the SOURCE — how many triangles each face fans to, and each face's
 * rim in the source's own split numbering. Both are passed rather than re-derived so that this
 * cannot disagree with the walk that produced the layer.
 *
 * Every refusal is BY NAME. A silent `null` here would be a mesh that draws with the source's
 * UVs while the attribute system reports the projected ones — the exact class of quiet wrongness
 * the corner domain was built to remove.
 */
export function materialiseCornerLayer(
  source: BufferGeometry,
  arity: readonly number[],
  rims: readonly PolygonRim[],
  layer: AttributeData,
  name: string,
): MaterialisedLayer {
  if (layer.domain !== 'corner')
    return { kind: 'refused', why: `the layer is at the '${layer.domain}' domain, not 'corner'` };
  const index = source.getIndex();
  if (index === null)
    return {
      kind: 'refused',
      why: 'the source carries no index buffer, so it has no faces to walk',
    };
  const position = source.getAttribute('position');
  if (position === undefined)
    return { kind: 'refused', why: 'the source carries no position attribute' };
  if (rims.length !== arity.length)
    return {
      kind: 'refused',
      why: `${rims.length} rims against ${arity.length} face arities — the two describe different meshes`,
    };

  let corners = 0;
  for (const rim of rims) corners += rim.length;
  if (corners !== layer.count)
    return {
      kind: 'refused',
      why: `the layer carries ${layer.count} elements and the rims walk ${corners} corners`,
    };
  const components = corners === 0 ? 0 : layer.data.length / corners;
  if (!Number.isInteger(components) || components < 1)
    return {
      kind: 'refused',
      why: `${layer.data.length} values over ${corners} corners is not a whole number of components`,
    };

  let triangles = 0;
  for (const n of arity) triangles += n;
  if (triangles * 3 !== index.count)
    return {
      kind: 'refused',
      why: `the arities fan to ${triangles} triangles (${triangles * 3} index entries) and the built index holds ${index.count}`,
    };

  const before = position.count;
  // Output vertex `n` copies source vertex `origin[n]` and carries the layer value at
  // `outValue[n * components ...]`. Identity below `before`, so a position no rim reached keeps
  // its own index and its own value.
  const origin: number[] = [];
  for (let i = 0; i < before; i++) origin.push(i);
  const outValue: number[] = new Array(before * components).fill(0);
  /** Source vertex → the output vertices already minted for it, in mint order. */
  const minted = new Map<number, number[]>();
  /** Per face, source vertex → the output vertex that face's corner reads. */
  const perFace: Map<number, number>[] = [];

  let corner = 0;
  for (const rim of rims) {
    const map = new Map<number, number>();
    for (const vertex of rim) {
      const at = corner * components;
      const candidates = minted.get(vertex);
      let out = -1;
      if (candidates === undefined) {
        // The FIRST loop to reach a vertex keeps the vertex itself. That is what makes a mesh
        // with no disagreement anywhere come out identical to its source rather than merely
        // equivalent to it — the box row of the table above.
        out = vertex;
        for (let j = 0; j < components; j++) outValue[vertex * components + j] = layer.data[at + j];
        minted.set(vertex, [out]);
      } else {
        for (const candidate of candidates) {
          let same = true;
          for (let j = 0; j < components && same; j++)
            if (outValue[candidate * components + j] !== layer.data[at + j]) same = false;
          if (same) {
            out = candidate;
            break;
          }
        }
        if (out < 0) {
          out = origin.length;
          origin.push(vertex);
          for (let j = 0; j < components; j++) outValue.push(layer.data[at + j]);
          candidates.push(out);
        }
      }
      map.set(vertex, out);
      corner++;
    }
    perFace.push(map);
  }

  // ── The index, rewritten in place-for-place order ────────────────────────────────────────
  //
  // Only the VALUES move; the entries keep their positions and their count. That is what lets
  // `build()` re-derive material groups over this geometry unchanged: a group is a range over the
  // index, and no range moved.
  const starts = faceElementStarts(arity);
  const rewritten = new Uint32Array(index.count);
  for (let f = 0; f < arity.length; f++) {
    const map = perFace[f];
    for (let t = 0; t < arity[f]; t++) {
      const base = (starts[f] + t) * 3;
      for (let e = 0; e < 3; e++) {
        const vertex = index.getX(base + e);
        const to = map.get(vertex);
        // A triangle naming a vertex its own face's rim does not contain. Refused rather than
        // passed through: sending it at the un-split vertex would draw that corner with whichever
        // face happened to write there first, which is a plausible picture of a wrong answer.
        if (to === undefined)
          return {
            kind: 'refused',
            why: `face ${f} fans a triangle through vertex ${vertex}, which is not on its own rim`,
          };
        rewritten[base + e] = to;
      }
    }
  }

  // ── The attributes, every one of them ────────────────────────────────────────────────────
  //
  // Copied by NAME off the source rather than listing `position`/`normal`/`uv`, so a source
  // carrying anything else keeps it. Normals in particular are COPIED and never recomputed: a
  // UV seam splits a vertex without moving it, and `computeVertexNormals` over the split buffer
  // would flat-shade every face it touches — a sphere that turns faceted the moment a projection
  // is added, which reads as the projection breaking the mesh.
  const geometry = new BufferGeometry();
  for (const key of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(key);
    const itemSize = attribute.itemSize;
    const values = new Float32Array(origin.length * itemSize);
    for (let n = 0; n < origin.length; n++) {
      const from = origin[n];
      for (let j = 0; j < itemSize; j++) values[n * itemSize + j] = attribute.getComponent(from, j);
    }
    geometry.setAttribute(key, new BufferAttribute(values, itemSize, attribute.normalized));
  }
  geometry.setAttribute(name, new BufferAttribute(Float32Array.from(outValue), components));
  geometry.setIndex(new BufferAttribute(rewritten, 1));
  // Carried rather than dropped: `pointCountMismatch` reads a stamp `buildBevel` writes here to
  // decide whether a clamped bevel is allowed to weld low, and a projection over one inherits
  // both the geometry and the exemption. Dropping it would turn a correct clamped bevel into a
  // parity warning the moment a projection was added above it.
  geometry.userData = { ...source.userData };

  return { kind: 'materialised', geometry, duplicates: origin.length - before };
}
