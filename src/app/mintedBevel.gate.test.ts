// #814 — the first operator that MINTS elements, held at the ORDER level rather than the count.
//
// ── WHY A COUNT-LEVEL GATE WOULD NOT HAVE BEEN ENOUGH ─────────────────────────────────────
//
// `faceCountMismatch` compares an index-entry TOTAL and `pointCountMismatch` compares a point
// TOTAL. A layout with the right counts and the wrong arrangement passes both in silence, and
// the mesh it produces builds, draws and is wrong — which is the failure #800 met at the radix.
// Every other derived kind was safe from that by construction, because its output faces are its
// source's faces in a permutation nobody had to invent. A bevel invents all of them: two thirds
// of its faces came from no source face at all. So the arrangement is the thing under test, and
// the last row of this file DEMONSTRATES the blindness rather than asserting it — it swaps two
// same-arity faces of the real layout and shows every count-shaped check still passes.
//
// ── THE ORACLES ARE INDEPENDENT OF THE IMPLEMENTATION, WHICH IS THE POINT ─────────────────
//
//   1. A RUNNING BLENDER. The closed form was predicted and then observed in 5.1.1 at two
//      shapes before a line was written — counts AND the output arity multiset. The multiset is
//      the half that bites: a count-only comparison passes on a wrong rule, while the sphere's
//      `{3:16, 4:160, 8:2}` pins each of the three terms separately, since its two valence-8
//      pole n-gons and its 16 pole triangles come from different ones.
//   2. STRUCTURE THAT HOLDS FOR ANY CLOSED SOURCE, not just these two. Every output point sits
//      in exactly four output faces; the output has exactly twice as many edges as points; every
//      output edge has exactly two incident faces. None of those is the formula restated.
//   3. CLOSED-FORM POSITIONS. A unit cube chamfered by `a` has exactly the 24 points that
//      permute `(+/-0.5, +/-(0.5 - a), +/-(0.5 - a))` — derived from what a chamfer IS, not from
//      what the builder does.
//   4. THE BUILT INDEX BUFFER. Each face's boundary loop is recovered from the triangles three
//      actually holds and compared to the descriptor-side rim, per face, as a cyclic sequence.
//
// ⚠️ #812'S THREE TRIPWIRED ARMS STAY TRIPWIRED, and that is the design rather than a gap. That
// file held `faceArityOf`, `faceCornersOf` and `tiledCornerOrder` with a source tripwire because
// no descriptor could produce a hole, and said the day a minting kind exists they *"become
// executable rows"*. A bevel does not make them executable: it answers from its own layout and
// returns BEFORE reaching the gather those arms refuse in. Their refusal path is still
// unreachable, and claiming otherwise here would be the covered-but-unhonoured mistake.
//
// REF: src/app/bevelLayout.ts; src/app/geometryRegistry.ts (`buildBevel`); issue #814; #812.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Vector3 } from 'three';
import {
  boxGeometryRef,
  sphereGeometryRef,
  arrayGeometryRef,
  mirrorGeometryRef,
  subsetGeometryRef,
  bevelGeometryRef,
} from './modifierGeometry';
import { clear, getForRead } from './geometryRegistry';
import {
  faceArityOf,
  faceCornersOf,
  faceCountMismatch,
  faceCountOf,
  faceElementStarts,
  mappedFacesOf,
  materialisedTriangles,
  tiledCornerOrder,
  tiledFaceOrder,
} from './faceCount';
import { pointCountMismatch, pointCountOf, tiledPointOrder, weldByPosition } from './pointIdentity';
import { edgeCountOf, edgeFaceAdjacencyOf, edgeSetOf, weldedPolygonsOf } from './edgeIdentity';
import { bevelLayoutOf, type BevelLayout } from './bevelLayout';
import { builtPolygonRims, composedWeldOf } from './builtRims';
import { carriageForDomain } from '../nodes/meshAttributes';
import { MATERIAL_INDEX, type AttributeData } from '../nodes/attributes';
import { mintAttributes } from '../nodes/attributeKey';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import { registerAllNodes } from '../nodes/registerAll';
import { __resetRegistryForTests } from '../core/dag';
import { insert } from './attributeStore';
import type { GeometryRef, ObjectData } from '../nodes/types';

const SIZE: [number, number, number] = [1, 1, 1];

function layoutOf(ref: GeometryRef): BevelLayout {
  const verdict = bevelLayoutOf(ref.descriptor);
  if (verdict.kind !== 'laid-out') throw new Error(`expected a layout, got: ${verdict.why}`);
  return verdict.layout;
}

function multiset(ns: readonly number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const n of ns) out[n] = (out[n] ?? 0) + 1;
  return out;
}

/** Twice the volume the triangles enclose. Positive exactly when the winding faces outward. */
function signedVolume(ref: GeometryRef): number {
  const geometry = getForRead(ref);
  if (geometry === null) throw new Error('nothing built');
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  let total = 0;
  for (let t = 0; t < index.count; t += 3) {
    const a = new Vector3().fromBufferAttribute(position, index.getX(t));
    const b = new Vector3().fromBufferAttribute(position, index.getX(t + 1));
    const c = new Vector3().fromBufferAttribute(position, index.getX(t + 2));
    total += a.dot(new Vector3().crossVectors(b, c)) / 6;
  }
  return total;
}

/**
 * Every face's rim recovered from the triangles the geometry ACTUALLY holds, in topological
 * point ids — the built-side counterpart of `BevelLayout.rims`.
 *
 * Deliberately NOT `alignedSplitRims`: that one rotates each rim onto the descriptor-side one and
 * returns `null` when it cannot, so asserting on its output would let the helper do the comparing.
 * This walks the index buffer and maps through the weld, and the comparison happens in the row.
 */
function builtWeldedRims(ref: GeometryRef): readonly (readonly number[])[] {
  const geometry = getForRead(ref);
  if (geometry === null) throw new Error('nothing built');
  const arity = faceArityOf(ref.descriptor)!;
  const raw = builtPolygonRims(geometry, arity, faceElementStarts(arity))!;
  const weld = composedWeldOf(ref)!;
  return raw.map((rim) => rim.map((split) => weld.map[split]));
}

/**
 * How many triangles face INWARD, for a convex shape centred on the origin.
 *
 * 🔴 THE STRONG WINDING ORACLE, AND `signedVolume > 0` IS NOT A SUBSTITUTE. Measured while
 * falsifying this file: reversing the vertex-fan walk flips all 8 of a bevelled cube's vertex
 * n-gons, and the total volume stays comfortably positive because 8 reversed triangles out of 44
 * do not outweigh the rest — every row in HALF B passed on a mesh with eight inside-out faces.
 * Per-triangle is what separates them, and it needs convexity, so it is used only where the
 * source is convex and centred: a bevelled box and a bevelled sphere. The array and mirror rows
 * keep the volume check, which is all a shape with three components can support.
 */
function inwardTriangles(ref: GeometryRef): number {
  const geometry = getForRead(ref);
  if (geometry === null) throw new Error('nothing built');
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  let inward = 0;
  for (let t = 0; t < index.count; t += 3) {
    const a = new Vector3().fromBufferAttribute(position, index.getX(t));
    const b = new Vector3().fromBufferAttribute(position, index.getX(t + 1));
    const c = new Vector3().fromBufferAttribute(position, index.getX(t + 2));
    const normal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    const centroid = a
      .clone()
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3);
    if (normal.dot(centroid) <= 0) inward++;
  }
  return inward;
}

/** `a` and `b` as the same cyclic sequence in the same direction, or not. */
function sameLoop(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const start = a.indexOf(b[0]);
  if (start < 0) return false;
  return b.every((v, i) => a[(start + i) % a.length] === v);
}

beforeEach(() => {
  // #825 row 12e evaluates real nodes, so the registry has to be seeded — the rest of this file
  // calls the builders directly and never needed it.
  __resetRegistryForTests();
  registerAllNodes();
  clear();
});

describe('#814 HALF A — the layout against oracles that are not the formula', () => {
  it('1 — the reference table: counts AND the corner multiset, at both shapes', () => {
    // Observed in a running Blender 5.1.1 via `bmesh.ops.bevel(affect='EDGES', segments=1,
    // clamp_overlap=False)`, predicted first and matched exactly. The sphere row is the one that
    // carries weight: mixed source arity and non-uniform valence, so each term of `F + E + V` is
    // pinned by a different part of the multiset.
    const cube = bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1);
    expect(faceCountOf(cube.descriptor)).toBe(26);
    expect(pointCountOf(cube.descriptor)).toEqual({ kind: 'counted', count: 24 });
    expect(edgeCountOf(cube.descriptor)).toEqual({ kind: 'counted', count: 48 });
    expect(multiset(faceCornersOf(cube.descriptor)!)).toEqual({ 3: 8, 4: 18 });

    const sphere = bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05);
    expect(faceCountOf(sphere.descriptor)).toBe(178);
    expect(pointCountOf(sphere.descriptor)).toEqual({ kind: 'counted', count: 176 });
    expect(edgeCountOf(sphere.descriptor)).toEqual({ kind: 'counted', count: 352 });
    expect(multiset(faceCornersOf(sphere.descriptor)!)).toEqual({ 3: 16, 4: 160, 8: 2 });
  });

  it('2 — structure that holds for ANY closed source, not just the two measured', () => {
    for (const ref of [
      bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1),
      bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05),
      bevelGeometryRef(arrayGeometryRef(boxGeometryRef(SIZE, null), 3, [3, 0, 0], null), 0.1),
      bevelGeometryRef(mirrorGeometryRef(boxGeometryRef(SIZE, null), 'x', 3, null), 0.1),
    ]) {
      const layout = layoutOf(ref);

      // Every output point is one source corner pulled inward, so it belongs to exactly four
      // output faces: its own shrunk face, the two edge quads on the rim edges meeting there,
      // and the vertex n-gon. True of any closed manifold source, and it is not the counting
      // formula said twice — it is a statement about which faces contain which points.
      const membership = new Array<number>(layout.points).fill(0);
      for (const rim of layout.rims) for (const point of rim) membership[point]++;
      expect(multiset(membership)).toEqual({ 4: layout.points });

      // A corollary of the above for a closed surface, and an independent arithmetic check on
      // the edge count: 4 faces per point, each face contributing 2 rim edges at that point.
      const edges = edgeCountOf(ref.descriptor);
      expect(edges).toEqual({ kind: 'counted', count: 2 * layout.points });

      // The output is itself closed and manifold — which is what makes `bevel(bevel(x))` legal
      // rather than lucky, and what the next bevel up the chain will demand.
      const adjacency = edgeFaceAdjacencyOf(ref.descriptor)!;
      expect(multiset(adjacency.faces.map((f) => f.length))).toEqual({
        2: edgeSetOf(ref.descriptor)!.count,
      });
    }
  });

  it('3 — Euler closes, per connected component', () => {
    const rows: [GeometryRef, number][] = [
      [bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1), 1],
      [bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05), 1],
      // Three disjoint boxes, so the characteristic is 2 per component.
      [bevelGeometryRef(arrayGeometryRef(boxGeometryRef(SIZE, null), 3, [3, 0, 0], null), 0.1), 3],
      [bevelGeometryRef(mirrorGeometryRef(boxGeometryRef(SIZE, null), 'x', 3, null), 0.1), 2],
    ];
    for (const [ref, components] of rows) {
      const v = (pointCountOf(ref.descriptor) as { count: number }).count;
      const e = (edgeCountOf(ref.descriptor) as { count: number }).count;
      const f = faceCountOf(ref.descriptor)!;
      expect(v - e + f).toBe(2 * components);
    }
  });

  it('4 — the closed-form POSITIONS of a chamfered unit cube', () => {
    // Derived from what a chamfer is, with no reference to the builder: pulling each corner back
    // by `a` along both incident edges leaves one coordinate at the face plane and shortens the
    // other two. Exactly 24 such points, and they are the whole position set.
    const a = 0.1;
    const near = 0.5 - a;
    const expected = new Set<string>();
    for (const axis of [0, 1, 2]) {
      for (const s0 of [0.5, -0.5]) {
        for (const s1 of [near, -near]) {
          for (const s2 of [near, -near]) {
            const p = [0, 0, 0];
            p[axis] = s0;
            p[(axis + 1) % 3] = s1;
            p[(axis + 2) % 3] = s2;
            expected.add(p.map((n) => n.toFixed(4)).join(','));
          }
        }
      }
    }
    expect(expected.size).toBe(24);

    const ref = bevelGeometryRef(boxGeometryRef(SIZE, null), a);
    const position = getForRead(ref)!.getAttribute('position');
    const seen = new Set<string>();
    for (let i = 0; i < position.count; i++) {
      seen.add(
        [position.getX(i), position.getY(i), position.getZ(i)].map((n) => n.toFixed(4)).join(','),
      );
    }
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it('4b — FLAT shading, and the normals are a closed-form fact about a chamfered cube', () => {
    // The builder gives every output face its own split vertices so `computeVertexNormals` yields
    // one normal per face. That claim had no reader until this row: a shared-vertex build would
    // average the chamfer strip into the faces around it and produce a rounded blob, which every
    // count, order and position check above passes unchanged.
    //
    // For a unit cube the multiset is forced: 6 face normals on the axes, 12 edge-quad normals
    // bisecting a right angle at 1/sqrt(2), and 8 corner normals at 1/sqrt(3). 26 distinct, one
    // per face, over 96 split vertices.
    const geometry = getForRead(bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1))!;
    const normal = geometry.getAttribute('normal');
    expect(normal.count).toBe(6 * 4 + 12 * 4 + 8 * 3);

    const distinct = new Map<string, number>();
    for (let i = 0; i < normal.count; i++) {
      const key = [normal.getX(i), normal.getY(i), normal.getZ(i)]
        .map((n) => n.toFixed(3))
        .join(',');
      distinct.set(key, (distinct.get(key) ?? 0) + 1);
    }
    expect(distinct.size).toBe(26);

    const magnitudes = multiset(
      [...distinct.keys()].map(
        (key) => key.split(',').filter((n) => Math.abs(Number(n)) > 1e-6).length,
      ),
    );
    // 6 normals with one non-zero component, 12 with two, 8 with three.
    expect(magnitudes).toEqual({ 1: 6, 2: 12, 3: 8 });
  });

  it('5 — the ORDER: the input first and named, everything minted and null', () => {
    const ref = bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1);
    const order = tiledFaceOrder(ref.descriptor)!;
    const layout = layoutOf(ref);

    expect(order.sourceFaces).toBe(6);
    expect(order.order).toHaveLength(26);
    // The whole input, in source order, carrying its own provenance — the same rule a generator
    // follows, so "the leading `sourceFaces` entries are the input" is one statement everywhere.
    expect(order.order.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    // And the hole falls on EXACTLY the minted faces: the `E` quads and the `V` n-gons.
    expect(order.order.slice(6)).toEqual(new Array(12 + 8).fill(null));
    // So the whole order refuses to be read as a gather — which is what makes face attributes
    // decline rather than invent. [[V305]].
    expect(mappedFacesOf(order.order)).toBeNull();
    expect(layout.sourceEdges).toBe(12);
  });

  it('6 — the POINT order has no holes, and every source point is used its valence times', () => {
    // The asymmetry #812 was built to express. A minted FACE came from no source face; a minted
    // POINT is one source point pulled along one face, so the point domain keeps an honest
    // origin for every element — and how many times each appears is that point's valence.
    const ref = bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1);
    const points = tiledPointOrder(ref.descriptor)!;
    expect(points.sourcePoints).toBe(8);
    expect(points.order).toHaveLength(24);
    expect(points.order.every((p) => typeof p === 'number' && p >= 0 && p < 8)).toBe(true);
    // A cube's every corner has valence 3, so each source point is the origin of 3 output points.
    expect(multiset(Object.values(multiset(points.order)))).toEqual({ 3: 8 });
  });
});

describe('#814 HALF B — the layout against the geometry that was actually built', () => {
  it('7 — 🔴 every face rim, recovered from the index buffer, per face', () => {
    // THE order-level row. `builtPolygonRims` walks the triangles three actually holds and
    // recovers each face's boundary loop; the comparison is against the descriptor-side rim, one
    // face at a time, as a cyclic sequence — a rim rotated by one corner bounds the same face and
    // fans to the same triangles, so direction and membership are what can be checked here.
    for (const ref of [
      bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1),
      bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05),
      bevelGeometryRef(arrayGeometryRef(boxGeometryRef(SIZE, null), 3, [3, 0, 0], null), 0.1),
    ]) {
      const layout = layoutOf(ref);
      const built = builtWeldedRims(ref);
      expect(built).toHaveLength(layout.rims.length);
      const wrong = layout.rims
        .map((rim, f) => (sameLoop(built[f], rim) ? null : f))
        .filter((f): f is number => f !== null);
      expect(wrong).toEqual([]);
      // And the descriptor-side rims are what `weldedPolygonsOf` publishes, so the next operator
      // up the chain reads the same arrangement this row just checked.
      expect(weldedPolygonsOf(ref.descriptor)).toEqual(layout.rims);
    }
  });

  it('8 — the built geometry agrees with every count the descriptor derives', () => {
    for (const ref of [
      bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1),
      bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05),
    ]) {
      const geometry = getForRead(ref)!;
      const arity = faceArityOf(ref.descriptor)!;
      expect(geometry.getIndex()!.count).toBe(materialisedTriangles(arity) * 3);
      expect(faceCountMismatch(ref.descriptor, geometry.getIndex()!.count)).toBeNull();
      expect(pointCountMismatch(ref.descriptor, geometry, () => null)).toBeNull();
      expect(weldByPosition(geometry).points).toBe(
        (pointCountOf(ref.descriptor) as { count: number }).count,
      );
      // 🔴 NOT ONE TRIANGLE INWARD. A reversed vertex n-gon or edge quad bounds the same face,
      // fans to the same triangles and renders inside-out — no count-shaped check sees it, and
      // neither does the total volume, which stays positive with eight faces flipped. Both
      // sources here are convex and centred on the origin, which is what makes the per-triangle
      // test available; it is the row that fails when the fan is walked the wrong way round.
      expect(inwardTriangles(ref)).toBe(0);
      expect(signedVolume(ref)).toBeGreaterThan(0);
    }
  });

  it('9 — a bevel of a bevel, because the output has to be a legal input', () => {
    const twice = bevelGeometryRef(bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1), 0.02);
    // F=26 E=48 V=24 -> 98 faces; its points are the once-bevelled corners, 6*4 + 12*4 + 8*3.
    expect(faceCountOf(twice.descriptor)).toBe(98);
    expect(pointCountOf(twice.descriptor)).toEqual({ kind: 'counted', count: 96 });
    expect(getForRead(twice)).not.toBeNull();
    expect(signedVolume(twice)).toBeGreaterThan(0);
  });
});

describe('#814 HALF C — what it refuses, and the drop it makes loud', () => {
  it('10 — an open mesh is refused BY NAME, with the edge that could not be answered for', () => {
    const sub = subsetGeometryRef(boxGeometryRef(SIZE, null), '0-2', true);
    const verdict = bevelLayoutOf(bevelGeometryRef(sub, 0.1).descriptor);
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') throw new Error('unreachable — asserted above');
    expect(verdict.why).toMatch(/exactly 2 incident faces/);
    // The specific edge, not just the condition — a director reading the console learns which.
    expect(verdict.why).toMatch(/edge \d+ \(points \d+-\d+\)/);
    expect(verdict.why).toMatch(/miter rule/);
    // And it propagates as an absence rather than a wrong number.
    expect(faceCountOf(bevelGeometryRef(sub, 0.1).descriptor)).toBeNull();
  });

  it('10b — a non-positive amount has no constructor, and an overshooting one is CLAMPED', () => {
    // The refusal, and its two measurements.
    expect(() => bevelGeometryRef(boxGeometryRef(SIZE, null), 0)).toThrow(/positive amount/);
    expect(() => bevelGeometryRef(boxGeometryRef(SIZE, null), -0.1)).toThrow(/inside out/);

    // ⚠️ THIS ROW USED TO RECORD AN OPEN LIMIT AND NOW RECORDS A CLOSED ONE — #817 LANDED.
    // It read: 0.4 welds to 24, 0.5 to 6, and 0.9 back to 24, that last being the silent case —
    // corners overshot PAST each other, the count came back right, and nothing warned. #817
    // quoted these exact numbers so that the day a clamp landed there would be a figure to fix
    // rather than a description. This is that fix.
    //
    // Now the amount is clamped to the largest the geometry can accommodate, so at a unit cube:
    //
    //   0.4  welds to 24 — below the limit, untouched, and byte-identical to before the clamp
    //   0.5  welds to  6 — AT the limit; every face's corners meet at its centre
    //   0.9  welds to  6 — clamped BACK to the limit, so it is the same geometry as 0.5
    //
    // 🔑 THE THIRD ROW IS THE WHOLE ISSUE, INVERTED. It was the silent overshoot; it is now
    // indistinguishable from the limit, which is what a clamp means.
    const welds = (amount: number) => {
      clear();
      const geometry = getForRead(bevelGeometryRef(boxGeometryRef(SIZE, null), amount))!;
      return weldByPosition(geometry).points;
    };
    expect(welds(0.4)).toBe(24);
    expect(welds(0.5)).toBe(6);
    expect(welds(0.9)).toBe(6);
  });

  it('10c — the derived kinds compose OVER a bevel, not just under it', () => {
    // A minting kind has to be a legal SOURCE as well as a legal output, or the operator is a
    // dead end in a chain. Each of these gathers through the bevel's face order, which is the
    // one with holes in it — and each is fine, because a hole refuses only what reads it as a
    // gather FROM a source face, and these read the bevel as their source's whole face set.
    const bevel = bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1);
    const rows: [GeometryRef, number, number][] = [
      [arrayGeometryRef(bevel, 3, [3, 0, 0], null), 78, 72],
      [mirrorGeometryRef(bevel, 'x', 3, null), 52, 48],
      [subsetGeometryRef(bevel, '0-5', true), 6, 24],
    ];
    for (const [ref, faces, points] of rows) {
      expect(faceCountOf(ref.descriptor)).toBe(faces);
      expect(pointCountOf(ref.descriptor)).toEqual({ kind: 'counted', count: points });
      expect(faceArityOf(ref.descriptor)).toHaveLength(faces);
      expect(weldedPolygonsOf(ref.descriptor)).toHaveLength(faces);
      expect(getForRead(ref)).not.toBeNull();
    }
  });

  it('11 — a source whose own buffers are outside the descriptor propagates, not invents', () => {
    const gltf: GeometryRef = {
      key: 'gltf|a|b',
      descriptor: { kind: 'gltf', assetRef: 'a', childName: 'b' },
    };
    const bevel = bevelGeometryRef(gltf, 0.1);
    expect(faceCountOf(bevel.descriptor)).toBeNull();
    const points = pointCountOf(bevel.descriptor);
    expect(points.kind).toBe('outside-the-descriptor');
  });

  it('12 — face and corner attributes REFUSE; the point domain is untouched', () => {
    const ref = bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1);
    const faces = tiledFaceOrder(ref.descriptor)!;

    // Corner: no order at all for a minting kind, so nothing can be gathered through one.
    expect(tiledCornerOrder(ref.descriptor)).toBeNull();

    // 🔴 THIS ROW ASSERTED A REFUSAL UNTIL #825, AND THE REVERSAL IS THE POINT OF THAT ISSUE.
    //
    // #814 decided that a minted face's attributes DROP — deliberately stricter than the
    // reference, which copies a neighbour's value — and its own body named the way back:
    // *"the day they should survive, the answer is a second map, not a looser first one."*
    // #825 built that second map. `faceOrder` still says a minted face came from NOWHERE and
    // `mappedFacesOf` still refuses to invent a provenance; `representative` answers the
    // different question of what it INHERITS from, and this arm consults it only after the
    // first comes back holed.
    //
    // Grounded rather than preferred: `bmesh_bevel.cc:1248-1254` creates each minted face with a
    // `facerep` and calls `BM_elem_attrs_copy(bm, facerep, f)` — face data is COPIED from one
    // representative face. The CORNER domain is the one that still refuses, and for a reason no
    // second map fixes: `:1279` interpolates loop data spatially instead.
    //
    // ⚠️ THE CORNER ORDER STAND-IN IS GONE. It existed because `carriageForDomain` required an
    // order a bevel does not have; #825 made that parameter nullable, so this row now hands it
    // the `null` production hands it, and the two domains are asked the same way the real road
    // asks them.
    const data: AttributeData = {
      domain: 'face',
      type: 'int',
      count: 6,
      data: new Int32Array([0, 0, 0, 1, 1, 1]),
    };
    const points = tiledPointOrder(ref.descriptor)!;
    const face = carriageForDomain(data, 'bevel', faces, null, points);

    // FACE: lays out now, and THROUGH THE REPRESENTATIVE rather than through the order. Asserted
    // on the identity of the array it names, not merely on `kind`: a layout that had somehow
    // gathered through the holed order would also report `laid-out`.
    expect(face.kind).toBe('laid-out');
    if (face.kind !== 'laid-out') throw new Error('unreachable — asserted above');
    expect(face.layout.order).toBe(faces.representative);
    expect(face.layout.order).not.toBe(faces.order);
    // Total where the provenance is holed — the two maps disagree, which is why there are two.
    expect(face.layout.order).toHaveLength(faces.order.length);
    expect(face.layout.order.every((f) => typeof f === 'number')).toBe(true);
    expect(faces.order.filter((f) => f === null)).toHaveLength(20);

    // CORNER: still refuses, and names #825's second slice. This is the domain a second map
    // cannot rescue — the reference interpolates it at a position, and this road has none.
    const corner = carriageForDomain(
      { domain: 'corner', type: 'float2', count: 24, data: new Float32Array(48) },
      'bevel',
      faces,
      null,
      points,
    );
    expect(corner.kind).toBe('refused');
    if (corner.kind !== 'refused') throw new Error('unreachable — asserted above');
    expect(corner.until).toBe('#825');
    expect(corner.why).toMatch(/interpolat/i);

    // ⚠️ THIS SOURCE CARRIES NO ATTRIBUTES AT ALL — `boxGeometryRef(SIZE, null)` — so its bevel
    // has no component for the reason it never had one: there is nothing to carry. That is a
    // DIFFERENT absence from the drop this row used to assert, and stating it here keeps the two
    // from being read as the same fact. The source that does carry one is row 12b.
    expect(ref.attributeKey).toBeUndefined();
    expect(ref.key).not.toMatch(/\|a:/);
  });

  it('12b — 🔑 a bevel of an ATTRIBUTED source now carries the set, on the representative map', () => {
    // The other half of row 12, and the one a director feels. Row 12 shows the carriage laying
    // out; this shows the handle and the BUILT geometry carrying the result, which is the claim
    // #825 actually makes. Before it, a bevelled two-material box drew in one material.
    const minted = mintAttributes({
      [MATERIAL_INDEX]: {
        domain: 'face',
        type: 'int',
        count: 6,
        data: new Int32Array([0, 0, 0, 1, 1, 1]),
      } as AttributeData,
    })!;
    insert(minted.key, minted.set, 'evaluate');
    const src = boxGeometryRef(SIZE, minted.key);
    const ref = bevelGeometryRef(src, 0.1);

    expect(ref.attributeKey).toBeDefined();
    expect(ref.key).toMatch(/\|a:/);

    // 🔴 AND THE ASSIGNMENT IS READ BACK OFF THE BUILT INDEX BUFFER, not off the key. A key that
    // merely differs proves the two builds are distinguished; it does not prove the right
    // triangles wear the right material, which is the failure #649 and [[H512]] are both about.
    const built = getForRead(ref)!;
    const groups = built.groups;
    expect(groups.length).toBeGreaterThan(1);
    const total = groups.reduce((n, g) => n + g.count, 0);
    // 26 output faces fan to 44 triangles = 132 index entries, and every one is claimed exactly
    // once — so no triangle is left materialless and none is double-counted.
    expect(total).toBe(132);
    expect(built.getIndex()!.count).toBe(132);
    // BOTH slots survive. A representative map that had collapsed to one face would show up here
    // as a single group, which is precisely the pre-#825 picture.
    expect(new Set(groups.map((g) => g.materialIndex))).toEqual(new Set([0, 1]));
  });

  it('12c — 🔴 THE TIE-BREAK IS PINNED, because every other row is BLIND to it', () => {
    // 🔴 THIS ROW EXISTS BECAUSE A FALSIFICATION FOUND THE GATE BLIND. Flipping the tie-break
    // from lowest candidate face to HIGHEST changes which material every chamfer wears — measured
    // on this fixture, `[0,0,0,0,1,1,1,1,2,2,3,3,…]` becomes `[2,4,3,5,2,5,3,4,…]` and the built
    // groups go from mostly slot 0 to mostly slot 1 — and rows 12, 12b and 13 ALL STILL PASSED.
    // They assert that both slots survive and that every triangle is claimed exactly once, and
    // both of those are true under either rule. So they check that a representative map EXISTS
    // and never which one, which is the same blindness the count checks have about face order.
    const v = bevelLayoutOf(bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1).descriptor);
    expect(v.kind).toBe('laid-out');
    if (v.kind !== 'laid-out') throw new Error('unreachable — asserted above');
    const { representative, faceOrder, sourceFaces } = v.layout;

    // The map itself, exactly. A cube: 6 faces map to themselves, then 12 edge quads take the
    // lower of their two incident faces, then 8 corner n-gons the lowest around each point.
    expect([...representative]).toEqual([
      0, 1, 2, 3, 4, 5, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 0, 0, 0, 0, 1, 1, 1, 1,
    ]);

    // The properties the literal is supposed to have, stated beside it so a future re-measure
    // can tell a legitimate move from a broken one: total, in range, and agreeing with the
    // provenance map exactly on the stretch where provenance exists.
    expect(representative).toHaveLength(faceOrder.length);
    expect(representative.every((f) => Number.isInteger(f) && f >= 0 && f < sourceFaces)).toBe(
      true,
    );
    for (let i = 0; i < faceOrder.length; i++) {
      if (faceOrder[i] !== null) expect(representative[i]).toBe(faceOrder[i]);
    }
    // …and diverging over the minted tail, which is the only reason there are two maps.
    expect(faceOrder.filter((f) => f === null)).toHaveLength(20);
  });

  it('12d — the map is total and in range on a MIXED-ARITY source, not just a cube', () => {
    // The row that bites, for the reason #814's Blender table gives: a cube has uniform valence
    // and uniform arity, so a rule that happened to index the wrong thing can still land in
    // range on every entry. A uv sphere has valence-4 rings and two valence-8 poles.
    const sphere = sphereGeometryRef(1, 8, 6, null);
    const v = bevelLayoutOf(bevelGeometryRef(sphere, 0.02).descriptor);
    expect(v.kind).toBe('laid-out');
    if (v.kind !== 'laid-out') throw new Error('unreachable — asserted above');
    const { representative, faceOrder, sourceFaces } = v.layout;
    expect(representative).toHaveLength(faceOrder.length);
    expect(representative).toHaveLength(178);
    expect(representative.every((f) => Number.isInteger(f) && f >= 0 && f < sourceFaces)).toBe(
      true,
    );
    // Non-vacuity: the minted tail really is most of this shape, so "all in range" is a claim
    // about 130 invented entries and not about 48 copied ones.
    expect(faceOrder.filter((f) => f === null)).toHaveLength(130);

    // 🔴 THE CORNER RULE CANNOT BE FALSIFIED BY SUBSTITUTION, AND SAYING SO IS THE POINT.
    // Replacing "lowest face around the point" with "the face the fan happens to START at" leaves
    // the output byte-identical — at a cube AND at this sphere. That is not a weak fixture: the
    // fan begins at `cornersAtPoint[v][0]`, an array filled by a loop over faces in increasing
    // order, so the fan's first face IS the lowest one by construction. The two rules agree
    // because of a property of an unrelated loop, not because either was checked.
    //
    // So a substitution test would report "no difference" and prove nothing. What this row does
    // instead is compute the expected map from an INDEPENDENT source — the substrate's welded
    // rims — and compare. That catches the case the substitution cannot: the day someone reorders
    // that fill, the fan-start rule would quietly name a different face and this stays correct.
    const { sourceFaces: F, sourceEdges: E } = v.layout;

    // THE INDEPENDENT ORACLE. Derived from `weldedPolygonsOf` and `edgeFaceAdjacencyOf` — the
    // substrate's own answers about the SOURCE — with no reference to `bevelLayoutOf`'s internals,
    // its fan walk, or the order anything is scanned in. If the layout's rule and this one ever
    // disagree, one of them changed and the diff says which entry.
    const rims = weldedPolygonsOf(sphere.descriptor)!;
    const adjacency = edgeFaceAdjacencyOf(sphere.descriptor)!;
    const facesAtPoint = new Map<number, number[]>();
    rims.forEach((rim, f) => {
      for (const point of rim) {
        const at = facesAtPoint.get(point) ?? [];
        at.push(f);
        facesAtPoint.set(point, at);
      }
    });
    const expected = [
      ...rims.map((_, f) => f),
      ...adjacency.faces.map((incident) => Math.min(...incident)),
      ...[...Array(v.layout.sourcePoints).keys()].map((p) => Math.min(...facesAtPoint.get(p)!)),
    ];
    expect([...representative]).toEqual(expected);

    // Non-vacuity: the oracle is not the trivially-satisfiable identity. Most of it disagrees
    // with the face index it sits at, so an implementation returning `i` would fail it.
    expect(expected.filter((f, i) => f !== i).length).toBeGreaterThan(120);
    expect(F).toBe(48);
    expect(E).toBe(88);
  });

  it('12e — 🔑 THROUGH THE NODES: a scoped material override, then a bevel, keeps both slots', () => {
    // The composition row, and it exists because the app observation for #825 did NOT show this
    // and the reason was instructive. Adding a Bevel from the panel splices it onto the MODIFIER
    // stack, which sits BELOW the material stack on the data lane — so a scoped
    // `MaterialOverrideOp` applies to the BEVELLED geometry's first three faces, not to the
    // source's. The rendered `[18@slot1, 114@slot0]` was correct for the graph the app built and
    // said nothing about inheritance. This row builds the order that does.
    //
    // 🔴 SO THE DIRECTOR-FACING CASE FOR "BEVEL A MULTI-MATERIAL MESH" IS AN IMPORTED ONE, not a
    // scoped override — the stack ordering puts the override above every modifier by design.
    // Worth knowing before anyone goes looking for it in the panel.
    const box: ObjectData = {
      kind: 'MeshData',
      geometry: boxGeometryRef(SIZE, null),
      material: null,
      attributeKey: null,
    } as ObjectData;
    const overridden = evaluateNodeAlone(
      'MaterialOverrideOp',
      { color: '#ff0000', overridden: { color: true }, scope: '0-2', muted: false },
      { target: box },
    ) as { geometry: GeometryRef; materialSlots?: unknown[] };

    // The source really does carry two slots over six faces — the control, so a bevel that
    // carried nothing could not be mistaken for a source that had nothing.
    expect(overridden.materialSlots).toHaveLength(2);
    expect(getForRead(overridden.geometry)!.groups.map((g) => g.materialIndex)).toEqual([1, 0]);

    const bevelled = evaluateNodeAlone(
      'BevelModifier',
      { amount: 0.1, muted: false },
      { target: overridden },
    ) as { geometry: GeometryRef; materialSlots?: unknown[]; attributeKey?: string };

    // The table rides through the node, and the handle carries the gathered set.
    expect(bevelled.materialSlots).toHaveLength(2);
    expect(bevelled.attributeKey).toBe(bevelled.geometry.attributeKey);

    // 🔑 FIVE GROUPS, NOT TWO. Two would be the source's own assignment stopping at face 5 with
    // the 20 minted faces defaulting to slot 0; five is the assignment following the
    // representative map into the chamfers and alternating back. The literal is the shape of the
    // claim — a count alone would not separate those two pictures.
    const groups = getForRead(bevelled.geometry)!.groups;
    expect(groups.map((g) => [g.start, g.count, g.materialIndex])).toEqual([
      [0, 18, 1],
      [18, 18, 0],
      [36, 60, 1],
      [96, 12, 0],
      [108, 24, 1],
    ]);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(132);
  });

  it('13 — 🔑 a NON-UNIFORM assignment SURVIVES now, and nothing warns about losing it', () => {
    // 🔴 THIS ROW ASSERTED THE OPPOSITE UNTIL #825. It was the noise test for a warning that said
    // a bevel's per-face materials *"do not survive it. The mesh draws with its first material
    // only"* — and it was right while #814's drop stood. #825 made the varied case survive, so
    // the warning became a lying label and was removed rather than re-worded: it re-derived what
    // a bevel carries from the SOURCE's attribute set, never asking what the carriage laid out,
    // which is why the two could drift apart in a single commit.
    //
    // What the row measures now is the claim that replaced it, and it keeps the same shape — the
    // uniform case and the varied case, side by side, because a check that only looked at one
    // could not tell "carries everything" from "carries nothing".
    const carrying = (values: number[]) => {
      const minted = mintAttributes({
        [MATERIAL_INDEX]: {
          domain: 'face',
          type: 'int',
          count: values.length,
          data: new Int32Array(values),
        } as AttributeData,
      })!;
      insert(minted.key, minted.set, 'evaluate');
      return boxGeometryRef(SIZE, minted.key);
    };
    const slotsOf = (values: number[]) => {
      clear();
      const built = getForRead(bevelGeometryRef(carrying(values), 0.1))!;
      return {
        slots: new Set(built.groups.map((g) => g.materialIndex)),
        claimed: built.groups.reduce((n, g) => n + g.count, 0),
        indices: built.getIndex()!.count,
      };
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A uniform assignment: one slot, unchanged by #825 and never the interesting case.
      expect(slotsOf([0, 0, 0, 0, 0, 0]).slots).toEqual(new Set([0]));

      // 🔑 THE VARIED ONE, WHICH IS THE WHOLE ISSUE. Both slots reach the built geometry, every
      // triangle is claimed exactly once, and the total is the 44 triangles a bevelled cube fans
      // to. A representative map that collapsed would show one slot; one that over-claimed or
      // under-claimed would move `claimed` off `indices`.
      const varied = slotsOf([0, 0, 0, 1, 1, 1]);
      expect(varied.slots).toEqual(new Set([0, 1]));
      expect(varied.claimed).toBe(varied.indices);
      expect(varied.indices).toBe(132);

      // And NOTHING says they were lost. Asserted on the removed wording specifically, so this
      // reds if the warning is ever reintroduced without its premise coming back with it.
      const said = warn.mock.calls.flat().join('\n');
      expect(said).not.toMatch(/does not survive/);
      expect(said).not.toMatch(/first material only/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('#814 HALF D — why this file is not a count gate', () => {
  it('14 — 🔴 a right-count / wrong-order layout passes EVERY count-shaped check', () => {
    // Not an assertion that the count gates are weak — a DEMONSTRATION, on the real layout, that
    // they cannot see an arrangement error. Two faces of equal arity are swapped: the face total,
    // the arity array, the triangle total, the point total and the edge total are all bit-for-bit
    // unchanged, so `faceCountMismatch` and `pointCountMismatch` stay silent. Only the per-face
    // rim comparison in row 7 separates the two layouts, which is why that row exists.
    const ref = bevelGeometryRef(boxGeometryRef(SIZE, null), 0.1);
    const layout = layoutOf(ref);
    const geometry = getForRead(ref)!;

    const a = 6; // the first edge quad
    const b = 7; // the second — same arity, different rim
    expect(layout.corners[a]).toBe(layout.corners[b]);

    const swapped = layout.rims.map((rim, f) =>
      f === a ? layout.rims[b] : f === b ? layout.rims[a] : rim,
    );
    expect(swapped).not.toEqual(layout.rims);

    // Every count-shaped instrument is blind to the swap, by construction.
    const arity = faceArityOf(ref.descriptor)!;
    expect(materialisedTriangles(arity) * 3).toBe(geometry.getIndex()!.count);
    expect(faceCountMismatch(ref.descriptor, geometry.getIndex()!.count)).toBeNull();
    expect(pointCountMismatch(ref.descriptor, geometry, () => null)).toBeNull();
    expect(multiset(swapped.map((r) => r.length))).toEqual(
      multiset(layout.rims.map((r) => r.length)),
    );

    // And the order-level comparison is not.
    const built = builtWeldedRims(ref);
    const wrong = swapped
      .map((rim, f) => (sameLoop(built[f], rim) ? null : f))
      .filter((f): f is number => f !== null);
    expect(wrong).toEqual([a, b]);
  });
});
