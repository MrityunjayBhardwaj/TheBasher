// #776 (P5) — a corner is a POLYGON corner, and the count agrees with the geometry three builds.
//
// A corner is a loop: one slot per (face, point) incidence. A box has 24 of them, which is what
// `MeshElementCounts` has declared for a box since ns-1 and what `tiledCornerOrder` disagreed
// with until this phase, laying out the 36 corners of its twelve TRIANGLES instead.
//
// ── WHY A BOX CANNOT GATE THIS ON ITS OWN ────────────────────────────────────────────────
//
// Three different numbers get called "corner" in this codebase, and a box makes two of them
// equal:
//
//                        box      sphere 8x6
//   loops (this)          24          176
//   triangle corners      36          240
//   split render vertices 24           63
//
// The last column is what `uvAttributes.ts` lifts. Its agreement with the first on a box is a
// coincidence of `BoxGeometry`'s layout, and it is why every row below runs a sphere, and why
// the one-face subset is here: an open mesh breaks the closed-manifold identity that the
// otherwise-strongest independent check relies on.
//
// ── THE THREE INDEPENDENT GROUNDS ────────────────────────────────────────────────────────
//
//   1. AGAINST THE ARITY. `faceCornersOf` reads `rim.length`; `faceArityOf` reads
//      `rim.length - 2` and composes through the face order by its own gather. That they
//      satisfy `corners = arity + 2` at every descriptor is two derivations agreeing, not one
//      derived from the other — and `faceArityOf` is itself grounded against the built index
//      buffer by `faceCount.gate.test.ts`.
//
//   2. AGAINST THE EDGE SET. On a CLOSED manifold every edge is shared by exactly two faces, so
//      the face degrees sum to twice the edge count. `edgeSetOf` (#718) derives edges by a
//      completely different route — welded rims, first encounter — and is gated against the
//      built index by its own file. `24 = 2 x 12` on a box and `176 = 2 x 88` on a sphere is a
//      relation neither derivation can fake for the other. It does NOT hold on an open mesh and
//      is not applied to one: a one-face subset has 4 corners and 4 edges.
//
//   3. AGAINST THE BUILT INDEX BUFFER, WINDING AND ALL. Every merged face's claimed rim must fan
//      to exactly the triangles the registry actually built for that face, compared as ORDERED
//      triples up to rotation so that a reversal is visible rather than absorbed. This is the
//      check that found #785 — `weldedPolygonsOf` copied a reflected copy's rim verbatim, and
//      its only consumer at the time compared unordered pairs and could not see it.
//
// REF: src/app/faceCount.ts (`faceCornersOf`, `cornerCountOf`, `tiledCornerOrder`);
//      src/app/polygonLayout.ts (`polygonCornersOf`, `reversedCornerAt`);
//      src/app/edgeIdentity.ts (`weldedPolygonsOf` — the rims this grounds);
//      issues #776, #785, #770, #718, #777.

import { describe, expect, it } from 'vitest';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import {
  cornerCountOf,
  faceArityOf,
  faceCornersOf,
  faceCountOf,
  faceElementStarts,
  tiledCornerOrder,
  tiledFaceOrder,
} from './faceCount';
import { fanToTriangles, polygonCornersOf, reversedCornerAt } from './polygonLayout';
import { composePointWeld, pointCountOf, weldByPosition } from './pointIdentity';
import type { PointWeld } from './pointIdentity';
import { edgeCountOf, weldedPolygonsOf } from './edgeIdentity';
import { getForRead } from './geometryRegistry';

const box = boxGeometryRef([1, 1, 1], null);
const sphere = sphereGeometryRef(1, 8, 6, null);

/** Every descriptor the registry builds synchronously — the same population #718 gates over. */
const SYNC_BUILDABLE: readonly GeometryRef[] = [
  box,
  boxGeometryRef([2, 3, 4], null),
  sphere,
  sphereGeometryRef(1, 32, 16, null),
  // three raises a sphere's segments to its own minimum without reporting it, and every
  // derivation in this area must clamp identically or they disagree exactly here.
  sphereGeometryRef(1, 1, 1, null),
  sphereGeometryRef(0.5, 3, 2, null),
  arrayGeometryRef(box, 3, [2, 0, 0]),
  arrayGeometryRef(sphere, 2, [0, 3, 0]),
  mirrorGeometryRef(box, 'x', 1),
  mirrorGeometryRef(sphere, 'x', 1),
  mirrorGeometryRef(arrayGeometryRef(box, 2, [2, 0, 0]), 'z', 0),
  // A mirror of a mirror — the row that holds `reversedCornerAt` to being an INVOLUTION. A
  // reversal that dropped corner 0's fixed point would come back rotated here and nowhere else.
  mirrorGeometryRef(mirrorGeometryRef(box, 'x', 1), 'y', 1),
  subsetGeometryRef(box, '0', true),
  subsetGeometryRef(box, '0-2', true),
  subsetGeometryRef(box, '0-2', false),
  subsetGeometryRef(sphere, '0-9', true),
  // Scoped generators: the copy blocks are where a scope changes the shape of the layout, and
  // for an unscoped one the right block divisor is algebraically identical to its natural wrong
  // simplification — so no unscoped row can tell the two apart.
  arrayGeometryRef(box, 3, [2, 0, 0], '0-2'),
  arrayGeometryRef(box, 3, [2, 0, 0], '0'),
  arrayGeometryRef(box, 4, [2, 0, 0], '1-2'),
  mirrorGeometryRef(box, 'x', 1, '0-2'),
  mirrorGeometryRef(box, 'x', 1, '0'),
  arrayGeometryRef(sphere, 2, [0, 3, 0], '0-9'),
];

/**
 * Descriptors whose faces close a surface, so `corners = 2 x edges` applies.
 *
 * ⚠️ A SCOPED GENERATOR IS OPEN AND THE FIRST DRAFT OF THIS SAID OTHERWISE. A scoped Array
 * preserves the whole input — closed — and then copies only the SUBSET, which is a handful of
 * loose faces with a boundary. Measured on `array(box, 3, '0-2')`: 48 corners against 32 edges,
 * where the identity would want 64. An unscoped generator copies whole shells and stays closed.
 */
function isClosed(ref: GeometryRef): boolean {
  const d = ref.descriptor;
  if (d.kind === 'subset') return false;
  if (d.kind === 'array' || d.kind === 'mirror') return d.scope === undefined && isClosed(d.source);
  return d.kind === 'box' || d.kind === 'sphere';
}

/** The identity the SUBSTRATE declares — composed for derived kinds, not re-welded (#754). */
function declaredWeld(ref: GeometryRef): PointWeld {
  const d = ref.descriptor;
  if (d.kind !== 'array' && d.kind !== 'mirror' && d.kind !== 'subset')
    return weldByPosition(getForRead(ref)!);
  const merged = pointCountOf(d);
  const sourcePoints = pointCountOf(d.source.descriptor);
  expect(merged.kind).toBe('counted');
  expect(sourcePoints.kind).toBe('counted');
  return composePointWeld(
    declaredWeld(d.source),
    (merged as { count: number }).count / (sourcePoints as { count: number }).count,
  );
}

/**
 * A wound triangle, normalised by ROTATION ONLY — `(a,b,c) === (b,c,a)` but never `(a,c,b)`.
 *
 * The whole discriminating power of ground 3 is in that second half. A fan from corner 0 over a
 * rim and a fan over the same rim reversed produce the SAME SET of triangles as unordered
 * vertex triples, and opposite windings as ordered ones. Comparing sets of unordered triples
 * would be green against a rim that is backwards, which is precisely the state #785 shipped in.
 */
function wound(a: number, b: number, c: number): string {
  const min = Math.min(a, b, c);
  if (a === min) return `${a},${b},${c}`;
  if (b === min) return `${b},${c},${a}`;
  return `${c},${a},${b}`;
}

/** The triangles the registry actually built for face `f`, in composed-topological ids. */
function builtFace(ref: GeometryRef, f: number): string[] {
  const arity = faceArityOf(ref.descriptor)!;
  const starts = faceElementStarts(arity);
  const index = getForRead(ref)!.getIndex()!;
  const weld = declaredWeld(ref);
  const out: string[] = [];
  for (let t = 0; t < arity[f]; t++) {
    const i = (starts[f] + t) * 3;
    out.push(
      wound(weld.map[index.getX(i)], weld.map[index.getX(i + 1)], weld.map[index.getX(i + 2)]),
    );
  }
  return out;
}

/** The claimed rim of face `f`, fanned, in the same normalised form. */
function claimedFace(descriptor: GeometryDescriptor, f: number): string[] {
  const rim = weldedPolygonsOf(descriptor)![f];
  const flat = fanToTriangles([rim]);
  const out: string[] = [];
  for (let t = 0; t * 3 < flat.length; t++)
    out.push(wound(flat[t * 3], flat[t * 3 + 1], flat[t * 3 + 2]));
  return out;
}

const sorted = (xs: readonly string[]) => [...xs].sort().join('|');

describe('#776 — a corner is a polygon corner, at every sync-buildable descriptor', () => {
  it('1 — the count agrees with the arity: corners = arity + 2, per face', () => {
    for (const ref of SYNC_BUILDABLE) {
      const corners = faceCornersOf(ref.descriptor);
      const arity = faceArityOf(ref.descriptor);
      expect(corners, `${ref.key} has no corner counts`).not.toBeNull();
      expect(arity, `${ref.key} has no arity`).not.toBeNull();
      expect(corners!.length, `${ref.key} corner/arity length`).toBe(arity!.length);
      expect(corners!.length, `${ref.key} face count`).toBe(faceCountOf(ref.descriptor));
      for (let f = 0; f < arity!.length; f++)
        expect(corners![f], `${ref.key} face ${f}`).toBe(arity![f] + 2);
      expect(cornerCountOf(ref.descriptor), `${ref.key} total`).toBe(
        corners!.reduce((n, c) => n + c, 0),
      );
    }
  });

  it('2 — the count agrees with the welded rims, which compose by a different route', () => {
    // `faceCornersOf` gathers per-face COUNTS through the face order. `weldedPolygonsOf` gathers
    // whole RIMS and reverses the reflected ones. Neither reads the other, so their rim lengths
    // agreeing is evidence rather than a restatement.
    for (const ref of SYNC_BUILDABLE) {
      const rims = weldedPolygonsOf(ref.descriptor);
      const corners = faceCornersOf(ref.descriptor)!;
      expect(rims, `${ref.key} has no welded rims`).not.toBeNull();
      expect(
        rims!.map((r) => r.length),
        `${ref.key} rim lengths`,
      ).toEqual([...corners]);
    }
  });

  it('3 — on a CLOSED surface the corners are twice the edges', () => {
    // Sigma face-degrees = 2E, because every edge of a closed manifold is shared by exactly two
    // faces. `edgeSetOf` derives its answer by first encounter over the welded rims and is gated
    // against the built index by its own file, so this ties the corner count to a number nothing
    // here computed.
    let checked = 0;
    for (const ref of SYNC_BUILDABLE) {
      if (!isClosed(ref)) continue;
      const edges = edgeCountOf(ref.descriptor);
      expect(edges.kind, `${ref.key} edges`).toBe('counted');
      expect(cornerCountOf(ref.descriptor), `${ref.key}`).toBe(
        2 * (edges as { count: number }).count,
      );
      checked++;
    }
    // The denominator, so a filter that quietly matched nothing cannot read as a pass — and a
    // literal beside it, so a filter that quietly stopped matching cannot either.
    expect(checked).toBe(SYNC_BUILDABLE.filter(isClosed).length);
    expect(checked).toBe(12);
  });

  it('4 — the relation FAILS on an open mesh, so row 3 is a real constraint', () => {
    // Without this, row 3 would be satisfiable by any pair of derivations that happened to be
    // proportional. A one-face subset of a box keeps 4 corners and 4 edges — not 8.
    const open = subsetGeometryRef(box, '0', true).descriptor;
    expect(cornerCountOf(open)).toBe(4);
    expect(edgeCountOf(open)).toEqual({ kind: 'counted', count: 4 });
  });

  it('5 — the box numbers, spelled out, and the three readings that a box confuses', () => {
    expect(cornerCountOf(box.descriptor)).toBe(24); // six quads x four rim corners
    // The triangle-corner reading this replaced, and the split render vertex count that
    // `uvAttributes.ts` used to declare as a corner count. All three are 24 or 36 on a box.
    expect(getForRead(box)!.getAttribute('position')!.count).toBe(24);
    expect(faceArityOf(box.descriptor)!.reduce((n, a) => n + a, 0) * 3).toBe(36);

    // The sphere is what separates them, and it is why nothing above is checked on a box alone.
    expect(cornerCountOf(sphere.descriptor)).toBe(176);
    expect(getForRead(sphere)!.getAttribute('position')!.count).toBe(63);
    expect(faceArityOf(sphere.descriptor)!.reduce((n, a) => n + a, 0) * 3).toBe(240);
  });

  it('6 — every claimed rim fans to the triangles the registry actually built, WINDING AND ALL', () => {
    // Ground 3, and the row that found #785. Compared up to rotation but not up to reversal, so
    // a rim stated backwards reds here and nowhere else in the suite.
    let faces = 0;
    for (const ref of SYNC_BUILDABLE) {
      const count = faceCountOf(ref.descriptor)!;
      for (let f = 0; f < count; f++) {
        expect(sorted(claimedFace(ref.descriptor, f)), `${ref.key} face ${f}`).toBe(
          sorted(builtFace(ref, f)),
        );
        faces++;
      }
    }
    // The denominator, exactly: a loop that stopped iterating reads the same as one that passed.
    expect(faces).toBe(SYNC_BUILDABLE.reduce((n, r) => n + faceCountOf(r.descriptor)!, 0));
    expect(faces).toBe(977);
  });

  it('7 — an UNREVERSED rim would red row 6, so the winding check is not decorative', () => {
    // The falsification, run rather than asserted. `mirror(box)` is the smallest case: its first
    // six faces are the preserved source and its last six are reflected, so comparing a
    // reflected face against the rim its SOURCE has must disagree — and the same comparison on
    // an Array, which never reverses, must agree.
    const mirrored = mirrorGeometryRef(box, 'x', 1);
    const sourceRims = weldedPolygonsOf(box.descriptor)!;
    const offset = pointCountOf(box.descriptor);
    expect(offset.kind).toBe('counted');
    const shift = (offset as { count: number }).count;

    const unreversed = (f: number) => {
      const rim = sourceRims[tiledFaceOrder(mirrored.descriptor)!.order[f]].map((p) => p + shift);
      const flat = fanToTriangles([rim]);
      const out: string[] = [];
      for (let t = 0; t * 3 < flat.length; t++)
        out.push(wound(flat[t * 3], flat[t * 3 + 1], flat[t * 3 + 2]));
      return out;
    };

    // Face 6 is the first reflected copy. Verbatim is WRONG there and the real rim is right.
    expect(sorted(unreversed(6))).not.toBe(sorted(builtFace(mirrored, 6)));
    expect(sorted(claimedFace(mirrored.descriptor, 6))).toBe(sorted(builtFace(mirrored, 6)));

    // And an Array's copy is NOT reversed, so a fix that reversed unconditionally would red.
    const arrayed = arrayGeometryRef(box, 2, [2, 0, 0]);
    expect(sorted(claimedFace(arrayed.descriptor, 6))).toBe(sorted(builtFace(arrayed, 6)));
  });

  it('8 — the corner ORDER spans the corners it claims, and names its source corner', () => {
    // `tiledCornerOrder` is a permutation into the SOURCE's corner numbering. Its length is the
    // merged corner count, its denominator is the source's, and every entry decomposes back to
    // the face `tiledFaceOrder` says that merged face came from.
    for (const ref of SYNC_BUILDABLE) {
      const d = ref.descriptor;
      if (d.kind !== 'array' && d.kind !== 'mirror' && d.kind !== 'subset') continue;
      const corners = tiledCornerOrder(d)!;
      const faces = tiledFaceOrder(d)!;
      const sourceCorners = faceCornersOf(d.source.descriptor)!;
      const sourceStart = faceElementStarts(sourceCorners);

      expect(corners.order.length, `${ref.key} order length`).toBe(cornerCountOf(d));
      expect(corners.sourceCorners, `${ref.key} denominator`).toBe(
        cornerCountOf(d.source.descriptor),
      );

      const mergedCorners = faceCornersOf(d)!;
      const reversedFrom = d.kind === 'mirror' ? faces.sourceFaces : Infinity;
      let at = 0;
      for (let f = 0; f < faces.order.length; f++) {
        const sourceFace = faces.order[f];
        const rim = sourceCorners[sourceFace];
        expect(mergedCorners[f], `${ref.key} face ${f} rim`).toBe(rim);
        for (let k = 0; k < rim; k++) {
          const expected =
            sourceStart[sourceFace] + (f >= reversedFrom ? reversedCornerAt(k, rim) : k);
          expect(corners.order[at], `${ref.key} face ${f} corner ${k}`).toBe(expected);
          expect(corners.order[at]).toBeLessThan(corners.sourceCorners);
          at++;
        }
      }
      expect(at).toBe(corners.order.length);
    }
  });

  it('9 — the reversal is an INVOLUTION, which is what fixing corner 0 buys', () => {
    // ⚠️ THIS ROW WAS WRITTEN ON A FALSE PREMISE AND KEPT ON A TRUE ONE. The premise was that
    // `[0, 3, 2, 1]` and `[3, 2, 1, 0]` fan to the same wound triangles, so row 6 could not tell
    // them apart. Measured by substitution — `corners - 1 - k` in place of the real thing — row
    // 6 DOES red: the two fans split a quad along different diagonals and the built index has
    // one of them. What survives is the algebraic property, which no built geometry states:
    // applied twice the permutation is the identity, so a mirror of a mirror comes back in
    // source order. `mirror(mirror(box))` is in the fixture list for the same reason.
    for (const rim of [3, 4, 5, 8]) {
      for (let k = 0; k < rim; k++)
        expect(reversedCornerAt(reversedCornerAt(k, rim), rim), `rim ${rim} corner ${k}`).toBe(k);
    }
    expect([0, 1, 2, 3].map((k) => reversedCornerAt(k, 4))).toEqual([0, 3, 2, 1]);
  });

  it('10 — the generated arm reads rim lengths and refuses exactly where the layout does', () => {
    expect(polygonCornersOf(box.descriptor)).toEqual([4, 4, 4, 4, 4, 4]);
    // A sphere's pole rows are triangles and its middle rows quads — the arity that makes row 1
    // a real constraint rather than a constant plus two.
    const spherePolygons = polygonCornersOf(sphere.descriptor)!;
    expect(new Set(spherePolygons)).toEqual(new Set([3, 4]));
    expect(spherePolygons.filter((c) => c === 3)).toHaveLength(16); // two pole rows of 8
    expect(spherePolygons.reduce((n, c) => n + c, 0)).toBe(176);

    // Derived kinds have no rims in their own vertex numbering (#777); the COUNT still composes.
    expect(polygonCornersOf(arrayGeometryRef(box, 3, [2, 0, 0]).descriptor)).toBeNull();
    expect(cornerCountOf(arrayGeometryRef(box, 3, [2, 0, 0]).descriptor)).toBe(72);
  });

  it('11 — the escape hatch is named, and it is the same one every other domain declares', () => {
    // `gltf` and `baked` keep their buffers outside the descriptor, so nothing here can say how
    // many polygons they hold, let alone how many corners those polygons have.
    expect(cornerCountOf({ kind: 'gltf', assetRef: 'a', childName: 'c' })).toBeNull();
    expect(cornerCountOf({ kind: 'baked', hash: 'h', vertexCount: 3 })).toBeNull();
    // And the refusal PROPAGATES through a derived chain rather than being minted fresh.
    const overGltf = arrayGeometryRef(
      { key: 'gltf|a|c', descriptor: { kind: 'gltf', assetRef: 'a', childName: 'c' } },
      3,
      [2, 0, 0],
    );
    expect(cornerCountOf(overGltf.descriptor)).toBeNull();
  });
});
