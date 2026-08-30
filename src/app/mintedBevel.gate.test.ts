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
import { insert } from './attributeStore';
import type { GeometryRef } from '../nodes/types';

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

    // Face: the carriage declines, and names #786 as what would settle it — the refusal carries
    // its way out rather than being a dead end.
    //
    // ⚠️ THE CORNER ORDER HERE IS A SYNTHETIC FIXTURE, AND THAT IS THE HONEST SHAPE OF THIS ROW.
    // `carriageForDomain` REQUIRES one and a bevel has none, so in production the refusal happens
    // one step earlier — `mintTiledModifierAttributes` narrows the kind away before any order is
    // asked for, which is what the `attributeKey` assertions below actually observe. Supplying a
    // stand-in is the only way to reach the carriage and show WHICH of its inputs refuses: the
    // face order's hole, not the corner order's absence. Passing `null` instead compiled under
    // vitest and was caught only by the changed-file sweep, since `npm run typecheck` does not
    // see test files.
    const data: AttributeData = {
      domain: 'face',
      type: 'int',
      count: 6,
      data: new Int32Array([0, 0, 0, 1, 1, 1]),
    };
    const standInCorners = { sourceCorners: 24, order: [] as readonly number[] };
    const verdict = carriageForDomain(
      data,
      'bevel',
      faces,
      standInCorners,
      tiledPointOrder(ref.descriptor)!,
    );
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') throw new Error('unreachable — asserted above');
    expect(verdict.until).toBe('#786');
    expect(verdict.why).toMatch(/mint/i);

    // So the handle carries no attribute component. For the mapping kinds that collapse is
    // [[H512]]'s bug; here the output genuinely expresses no per-face assignment, so two sources
    // differing only in one produce the same geometry and SHOULD share a build.
    expect(ref.attributeKey).toBeUndefined();
    expect(ref.key).not.toMatch(/\|a:/);
  });

  it('13 — 🔴 the drop is LOUD for a real loss and SILENT for a uniform one', () => {
    // The noise test, and it is the half that makes the channel worth reading. Every primitive
    // mints a uniform `material_index`, so warning whenever a source "has a face attribute" would
    // fire on every bevel that will ever be built.
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

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      clear();
      getForRead(bevelGeometryRef(carrying([0, 0, 0, 0, 0, 0]), 0.1));
      const uniform = warn.mock.calls.flat().join('\n');
      expect(uniform).not.toMatch(/does not survive/);

      warn.mockClear();
      clear();
      getForRead(bevelGeometryRef(carrying([0, 0, 0, 1, 1, 1]), 0.1));
      const varied = warn.mock.calls.flat().join('\n');
      expect(varied).toMatch(/does not survive/);
      expect(varied).toMatch(/not uniform/);
      // Names its way out, exactly as the carriage refusal does.
      expect(varied).toMatch(/#786/);
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
