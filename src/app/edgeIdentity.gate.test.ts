// #718 (P4) — the derived edge set agrees with the geometry three.js actually builds.
//
// `edgeIdentity` derives edges from a DESCRIPTOR, because the count runs inside a node's pure,
// synchronous `evaluate()` and must not build a `BufferGeometry`. That makes it a SECOND
// SPELLING of three's vertex layout — the same hazard `faceCount.gate.test.ts` exists to close,
// one domain over, and a second spelling that agrees today passes every behavioural test until
// the day it stops agreeing.
//
// ── THE GROUND TRUTH, AND WHY IT IS NOT CIRCULAR ─────────────────────────────────────────
//
// For the two PRIMITIVES the check is direct: `polygonLayoutOf`'s split rims through
// `weldByPosition` of the built geometry, compared rim for rim.
//
// 🔑 THE DERIVED KINDS NEED SOMETHING ELSE, BECAUSE `polygonLayoutOf` REFUSES THEM (#777) — so
// the obvious comparison does not exist and a weaker one would be self-referential. The check
// used instead reads the BUILT INDEX BUFFER, which every kind has:
//
//     the welded index-pair set  =  the true edges  +  the fan diagonals
//
// A polygon of `k` corners fanned from corner 0 contributes `k - 3` diagonals, and `k = arity +
// 2`, so the diagonals total `materialisedTriangles - faces`. Both terms come from `faceCount`,
// which is grounded against the buffer by its own gate. That gives an exact predicted size AND
// a containment check — every derived edge must actually appear in the mesh — for descriptors
// whose rims cannot be stated at all.
//
// ⚠️ THE PREDICTION WAS CHECKED AGAINST FIGURES MEASURED BEFORE THIS CODE EXISTED. #718's
// 2026-08-25 block recorded welded-index edge counts of 18 for a box, 120 for a sphere 8x6 and
// 5,952 for a sphere 64x32. The rule above gives 12 + 6, 88 + 32 and 4,032 + 1,920 — the same
// three numbers, from a model those measurements had no part in building.
//
// REF: src/app/edgeIdentity.ts (the derivation); src/app/pointIdentity.ts (`weldByPosition`);
//      src/app/faceCount.ts (the arity the diagonal count comes from); issues #718, #716, #777.

import { describe, expect, it } from 'vitest';
import type { GeometryRef } from '../nodes/types';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import { faceArityOf, faceCountOf, materialisedTriangles } from './faceCount';
import { polygonLayoutOf } from './polygonLayout';
import { composePointWeld, pointCountOf, weldByPosition } from './pointIdentity';
import type { PointWeld } from './pointIdentity';
import { edgeCountOf, edgeSetOf, weldedPolygonsOf } from './edgeIdentity';
import { getForRead } from './geometryRegistry';

const box = boxGeometryRef([1, 1, 1], null);
const sphere = sphereGeometryRef(1, 8, 6, null);

const SYNC_BUILDABLE: readonly GeometryRef[] = [
  box,
  boxGeometryRef([2, 3, 4], null),
  sphere,
  sphereGeometryRef(1, 32, 16, null),
  // Clamp edges: three raises width to 3 and height to 2 without reporting it, and all four
  // derivations in this area must clamp identically or they disagree exactly here.
  sphereGeometryRef(1, 1, 1, null),
  sphereGeometryRef(0.5, 3, 2, null),
  arrayGeometryRef(box, 3, [2, 0, 0]),
  arrayGeometryRef(sphere, 2, [0, 3, 0]),
  mirrorGeometryRef(box, 'x', 1),
  mirrorGeometryRef(arrayGeometryRef(box, 2, [2, 0, 0]), 'z', 0),
  // 🔴 A ONE-FACE SUBSET IS NOT A SMALLER VERSION OF THE THREE-FACE ONE, IT IS THE ONLY ONE THAT
  // DISCRIMINATES. Three adjacent box faces happen to touch all eight corners, so a model that
  // wrongly equated a subset's points with its faces' points agrees there and fails here.
  subsetGeometryRef(box, '0', true),
  subsetGeometryRef(box, '0-2', true),
  subsetGeometryRef(box, '0-2', false),
  subsetGeometryRef(sphere, '0-9', true),
];

/**
 * The identity the SUBSTRATE declares for a ref, which is not always a position weld.
 *
 * 🔴 THE DIFFERENCE IS THE WHOLE REASON THIS HELPER EXISTS, AND A FIXTURE HERE DEPENDS ON IT.
 * #754 made a derived geometry's point identity COMPOSED — `source x copies` — rather than
 * re-welded from the merged result, and `pointCountMismatch` checks it against the SPLIT
 * position count for exactly that reason. The two answers diverge whenever copies land on top
 * of each other: `mirror(array(box, 2), 'z', 0)` mirrors a z-centred box across z = 0, so
 * every copy-1 position coincides with a copy-0 one and `weldByPosition` of the merged buffer
 * reports 16 points where the descriptor composes 32.
 *
 * Welding the merged geometry here would therefore measure POSITION identity and call the
 * descriptor wrong for agreeing with the substrate. The index buffer below is still the real,
 * built topology — only the naming of its points comes from the composed map.
 */
function declaredWeld(ref: GeometryRef): PointWeld {
  const d = ref.descriptor;
  if (d.kind !== 'array' && d.kind !== 'mirror' && d.kind !== 'subset')
    return weldByPosition(getForRead(ref)!);
  const source = declaredWeld(d.source);
  const merged = pointCountOf(d);
  const sourcePoints = pointCountOf(d.source.descriptor);
  expect(merged.kind).toBe('counted');
  expect(sourcePoints.kind).toBe('counted');
  const copies = (merged as { count: number }).count / (sourcePoints as { count: number }).count;
  return composePointWeld(source, copies);
}

/** Every distinct welded point PAIR the built index buffer joins — edges plus fan diagonals. */
function weldedIndexPairs(ref: GeometryRef, radix: number): Set<number> {
  const geom = getForRead(ref);
  expect(geom, `registry could not build ${ref.key}`).not.toBeNull();
  const index = geom!.getIndex();
  expect(index, `${ref.key} built without an index`).not.toBeNull();
  const weld = declaredWeld(ref);
  const pairs = new Set<number>();
  for (let t = 0; t < index!.count; t += 3) {
    const a = weld.map[index!.getX(t)];
    const b = weld.map[index!.getX(t + 1)];
    const c = weld.map[index!.getX(t + 2)];
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      if (p === q) continue;
      pairs.add(p < q ? p * radix + q : q * radix + p);
    }
  }
  return pairs;
}

describe('#718 — the edge set agrees with the built geometry', () => {
  it('derives welded rims that match a real weld, for every kind that states a layout', () => {
    let checked = 0;
    for (const ref of SYNC_BUILDABLE) {
      const layout = polygonLayoutOf(ref.descriptor);
      if (layout.kind !== 'laid-out') continue;
      const weld = weldByPosition(getForRead(ref)!);
      const observed = layout.polygons.map((rim) => rim.map((v) => weld.map[v]));
      expect(weldedPolygonsOf(ref.descriptor), `welded rims for ${ref.key}`).toEqual(observed);
      checked++;
    }
    // The census is asserted, not assumed: if `polygonLayoutOf` ever widened, this row would
    // silently start checking more and nobody would know which fixtures it covers.
    expect(checked, 'primitives with a stated layout').toBe(6);
  });

  it('every derived edge is really in the mesh, and the count is exactly edges + fan diagonals', () => {
    for (const ref of SYNC_BUILDABLE) {
      const set = edgeSetOf(ref.descriptor);
      expect(set, `no edge set for ${ref.key}`).not.toBeNull();
      const arity = faceArityOf(ref.descriptor);
      expect(arity, `no arity for ${ref.key}`).not.toBeNull();

      const pts = pointCountOf(ref.descriptor);
      expect(pts.kind).toBe('counted');
      const radix = (pts as { count: number }).count;
      const built = weldedIndexPairs(ref, radix);
      // Containment — every edge this module claims is a pair the geometry actually joins.
      for (let i = 0; i < set!.count; i++) {
        const key = set!.pairs[2 * i] * radix + set!.pairs[2 * i + 1];
        expect(built.has(key), `${ref.key}: derived edge ${i} is not in the built mesh`).toBe(true);
      }
      // Size — the diagonals are the whole of the difference, and they are counted from the
      // arity rather than from the geometry, so the two sides share no term.
      const diagonals = materialisedTriangles(arity!) - arity!.length;
      expect(built.size, `${ref.key}: welded index pairs`).toBe(set!.count + diagonals);
    }
  });

  it('reports the figures #718 was written to, and closes Euler on the closed shapes', () => {
    // The discriminating observation, stated as the issue states it.
    expect(edgeCountOf(box.descriptor)).toEqual({ kind: 'counted', count: 12 });
    expect(faceCountOf(box.descriptor)).toBe(6);
    // ...and NOT the 24 an index-derived set gives: six quads x four sides, each counted twice
    // because two faces sharing an edge do not share point indices on a split buffer.
    const rims = weldedPolygonsOf(box.descriptor)!;
    expect(rims.reduce((n, r) => n + r.length, 0)).toBe(24);

    // Euler, on the shapes whose component count is known. It does not care how the edge set was
    // derived, which is what makes it worth asserting alongside the containment above.
    const closed: readonly (readonly [GeometryRef, number])[] = [
      [box, 1],
      [sphere, 1],
      [sphereGeometryRef(1, 32, 16, null), 1],
      [arrayGeometryRef(box, 3, [2, 0, 0]), 3],
      [mirrorGeometryRef(box, 'x', 1), 2],
      [mirrorGeometryRef(arrayGeometryRef(box, 2, [2, 0, 0]), 'z', 0), 4],
    ];
    for (const [ref, components] of closed) {
      const v = pointCountOf(ref.descriptor);
      const e = edgeCountOf(ref.descriptor);
      expect(v.kind).toBe('counted');
      expect(e.kind).toBe('counted');
      const V = (v as { count: number }).count;
      const E = (e as { count: number }).count;
      const F = faceCountOf(ref.descriptor)!;
      expect(V - E + F, `Euler for ${ref.key}`).toBe(2 * components);
    }
  });

  it('the pairs are ordered, distinct and in range', () => {
    for (const ref of SYNC_BUILDABLE) {
      const set = edgeSetOf(ref.descriptor)!;
      const points = pointCountOf(ref.descriptor);
      expect(points.kind).toBe('counted');
      const P = (points as { count: number }).count;
      const seen = new Set<number>();
      for (let i = 0; i < set.count; i++) {
        const lo = set.pairs[2 * i];
        const hi = set.pairs[2 * i + 1];
        expect(lo, `${ref.key}: edge ${i} is not low-id-first`).toBeLessThan(hi);
        expect(hi, `${ref.key}: edge ${i} names a point outside the mesh`).toBeLessThan(P);
        const key = lo * P + hi;
        expect(seen.has(key), `${ref.key}: edge ${i} is a duplicate`).toBe(false);
        seen.add(key);
      }
      expect(set.pairs.length).toBe(2 * set.count);
    }
  });

  it('censuses the two kinds that cannot answer, exactly', () => {
    // The same escape hatch `faceCountOf` and `pointCountOf` declare. Counted rather than left
    // implicit: an escape hatch that is not censused is an escape hatch that widens.
    const outside = ['gltf', 'baked'] as const;
    for (const kind of outside) {
      const descriptor = { kind, source: null } as never;
      expect(weldedPolygonsOf(descriptor)).toBeNull();
      const verdict = edgeCountOf(descriptor);
      expect(verdict.kind).toBe('outside-the-descriptor');
    }
    expect(outside.length).toBe(2);
  });
});
