// #769 — the polygon layout says the same thing three.js's index buffer says.
//
// ── WHY EVERY ROW COMPARES TRIPLES AND NOT TOTALS ─────────────────────────────────────
//
// A layout with the right polygon COUNT and the wrong diagonal fans to the right NUMBER of
// triangles, of the right shape, covering the right surface — and is wrong. three splits a cell
// along `b–d`; a fan from `a` splits along `a–c`. Both give twelve triangles for a box and both
// cover it completely, so a count assertion, a coverage assertion and a bounding box are all
// green on the wrong one. The only thing that separates them is which vertices each triangle
// actually names, in which order.
//
// So these rows walk the real `geometry.index` and compare triangle by triangle, up to
// rotation. Rotation is allowed because a fan cannot avoid it and it changes nothing that
// renders (see `fanToTriangles`); the VERTEX SET, the WINDING and the ORDER are all asserted.
//
// REF: src/app/polygonLayout.ts; src/app/faceCount.ts (the counts these must not contradict);
//      node_modules/three/src/geometries/{Sphere,Box}Geometry.js; issues #769, #770, #736.

import { describe, expect, it } from 'vitest';
import { BoxGeometry, SphereGeometry, type BufferGeometry } from 'three';
import { fanToTriangles, polygonArityOf, polygonLayoutOf, type PolygonRim } from './polygonLayout';
import { faceCountOf } from './faceCount';
import type { GeometryDescriptor } from '../nodes/types';

const box = (): GeometryDescriptor => ({ kind: 'box', size: [1, 1, 1] });
const sphere = (w: number, h: number): GeometryDescriptor => ({
  kind: 'sphere',
  radius: 1,
  widthSegments: w,
  heightSegments: h,
});

/** The polygons, or a failure naming the refusal — never a `!` that hides which arm answered. */
function polygonsOf(d: GeometryDescriptor): readonly PolygonRim[] {
  const verdict = polygonLayoutOf(d);
  if (verdict.kind !== 'laid-out')
    throw new Error(`expected a layout for '${d.kind}', got '${verdict.kind}'`);
  return verdict.polygons;
}

/** Triangles of a flat index array, as triples. */
function triples(index: ArrayLike<number>): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < index.length; i += 3) out.push([index[i], index[i + 1], index[i + 2]]);
  return out;
}

/** The three rotations of a triple — the same triangle wound the same way. */
const rotations = (t: number[]): string[] => [
  `${t[0]},${t[1]},${t[2]}`,
  `${t[1]},${t[2]},${t[0]}`,
  `${t[2]},${t[0]},${t[1]}`,
];

/** Arity histogram, so a mixed-arity claim is asserted as a shape and not as a total. */
function arity(polygons: readonly PolygonRim[]): Record<number, number> {
  const m: Record<number, number> = {};
  for (const p of polygons) m[p.length] = (m[p.length] ?? 0) + 1;
  return m;
}

/**
 * The whole gate, as one function: the fan of the derived layout IS the built index buffer.
 * Returns nothing — it throws through `expect`, so a caller cannot forget to assert on it.
 */
function agreesWithBuiltBuffer(name: string, d: GeometryDescriptor, built: BufferGeometry) {
  const index = built.index;
  expect(
    index,
    `${name}: the fixture must be INDEXED or these rows compare nothing`,
  ).not.toBeNull();
  const real = triples(index!.array);
  const mine = triples(fanToTriangles(polygonsOf(d)));

  expect(mine.length, `${name}: triangle count`).toBe(real.length);
  // Triangle by triangle, in order. A set comparison would pass on a layout that produced the
  // right triangles in the wrong sequence, and group ranges are addressed by sequence.
  for (let t = 0; t < real.length; t++)
    expect(rotations(real[t]), `${name}: triangle ${t}`).toContain(mine[t].join(','));
}

describe('#769 — a polygon layout derived from a descriptor agrees with the geometry three builds', () => {
  it('a box is SIX quads, and its fan is the built index buffer', () => {
    const polygons = polygonsOf(box());
    expect(polygons).toHaveLength(6);
    expect(arity(polygons)).toEqual({ 4: 6 });
    agreesWithBuiltBuffer('box', box(), new BoxGeometry(1, 1, 1));
  });

  it('a sphere is w x h polygons — the pole rows COUNTED as triangles, not subtracted', () => {
    // 🔴 THE FIGURE #736 GOT WRONG, ASSERTED AT FOUR SIZES SO IT CANNOT BE A COINCIDENCE OF ONE.
    // Its scope section says `w x (h - 1)`, which is short by a whole row: every grid cell
    // yields one polygon and a pole cell yields a TRIANGLE rather than nothing.
    const cases = [
      // w, h, polygons, arity
      [8, 6, 48, { 3: 16, 4: 32 }],
      [16, 12, 192, { 3: 32, 4: 160 }],
      [5, 3, 15, { 3: 10, 4: 5 }],
      // h = 2 is the degenerate sphere: BOTH rows are pole rows, so there is not a quad in it.
      [3, 2, 6, { 3: 6 }],
    ] as const;

    for (const [w, h, count, shape] of cases) {
      const polygons = polygonsOf(sphere(w, h));
      expect(polygons.length, `w=${w} h=${h}`).toBe(count);
      expect(polygons.length, `w=${w} h=${h} is w x h`).toBe(w * h);
      expect(arity(polygons), `w=${w} h=${h}`).toEqual(shape);
      agreesWithBuiltBuffer(`sphere w=${w} h=${h}`, sphere(w, h), new SphereGeometry(1, w, h));
    }
  });

  it('the POLYGON total is what faceCountOf answers, and the fan is what it materialises to', () => {
    // 🔴 THIS ROW INVERTED AT #770, WHICH IS THE FLIP IN ONE ASSERTION. It read *"the TRIANGLE
    // total still agrees with faceCountOf — this changes no count"*, and that was the half of
    // #769's claim which said the phase was additive: the fan produced exactly as many
    // triangles as the face arithmetic derived, so nothing had moved yet.
    //
    // #770 moved it. `faceCountOf` answers POLYGONS now, so the count it agrees with is
    // `polygons.length` and the fan is what those polygons MATERIALISE to. Both halves are
    // asserted rather than only the new one, because the pair is the whole content of the
    // phase — a box is 6 faces and 12 triangles, and either number alone reads as the other's
    // old value.
    for (const d of [box(), sphere(8, 6), sphere(16, 12), sphere(5, 3), sphere(3, 2)]) {
      const polygons = polygonsOf(d);
      const fanned = fanToTriangles(polygons).length / 3;
      expect(polygons.length, `${d.kind} faces`).toBe(faceCountOf(d));
      // The arity is the projection every consumer of the flip actually gathers through, so it
      // is checked here against the fan it projects rather than trusted as a second walk.
      const arity = polygonArityOf(d)!;
      expect(arity.length, `${d.kind} arity length`).toBe(polygons.length);
      expect(
        arity.reduce((a, b) => a + b, 0),
        `${d.kind} triangles`,
      ).toBe(fanned);
    }
  });

  it("three's own segment clamps are applied, so this cannot disagree at the edges", () => {
    // Quoted from `SphereGeometry`'s constructor: `Math.max( 3, Math.floor( widthSegments ) )`
    // and `Math.max( 2, Math.floor( heightSegments ) )`. A second spelling that skipped them
    // would agree everywhere a test is written by hand and disagree exactly where one is not.
    expect(polygonsOf(sphere(1, 1))).toHaveLength(3 * 2);
    expect(polygonsOf(sphere(8.9, 6.9))).toHaveLength(8 * 6);
    agreesWithBuiltBuffer('sphere clamped low', sphere(1, 1), new SphereGeometry(1, 1, 1));
    agreesWithBuiltBuffer('sphere fractional', sphere(8.9, 6.9), new SphereGeometry(1, 8.9, 6.9));
  });

  it('🔴 the derived kinds REFUSE by name, and a refusal is not an absence', () => {
    // Two different answers, kept apart because a caller can act on only one of them. The
    // reason is measured, not hedged: a copy's rim needs a split vertex count only a built
    // geometry knows.
    const src = { key: 'k', descriptor: box() } as never;
    const derived: GeometryDescriptor[] = [
      { kind: 'array', source: src, count: 3, offset: [2, 0, 0] } as unknown as GeometryDescriptor,
      { kind: 'mirror', source: src, axis: 'x', merge: 0 } as unknown as GeometryDescriptor,
      { kind: 'subset', source: src, scope: '2-8', keep: true } as unknown as GeometryDescriptor,
    ];
    for (const d of derived) {
      const v = polygonLayoutOf(d);
      expect(v.kind, d.kind).toBe('not-yet');
      if (v.kind !== 'not-yet') throw new Error('unreachable — asserted above');
      // The same two fields a carriage refusal carries: a reason to act on, and its end.
      expect(v.why.length, d.kind).toBeGreaterThan(20);
      // ⚠️ IT POINTED AT #770 UNTIL #770 SHIPPED. An `until` naming a phase that has landed is
      // a refusal telling its reader to wait for something that already happened, which is
      // worse than naming nothing — so the field moves with the obstruction it describes.
      expect(v.until, d.kind).toBe('#777');
    }

    // 🔴 THE SCOPED AND UNSCOPED ARMS NOW GIVE THE SAME REASON, AND THAT IS THE POINT.
    //
    // This row used to assert the opposite: these kinds were blocked TWO ways, only one held
    // per descriptor, and an unscoped Array told about a scope sent its author to look at a
    // field that is not there. The discipline was right and its subject is gone — #770 made a
    // scope address POLYGONS, so a subset keeps whole polygons by construction and the
    // scope-shaped obstruction dissolved rather than being worked around.
    //
    // So what is checked now is that the retired reason did not survive its own repair. A
    // refusal still citing "half a polygon" after this phase would be naming a condition the
    // code no longer has — the decayed-premise failure, in the one place a reader looks to
    // find out why something is unavailable.
    const scopedArray = polygonLayoutOf({
      kind: 'array',
      source: src,
      count: 3,
      offset: [2, 0, 0],
      scope: '2-8',
      scopeDomain: 'face',
    } as unknown as GeometryDescriptor);
    const bareArray = polygonLayoutOf({
      kind: 'array',
      source: src,
      count: 3,
      offset: [2, 0, 0],
    } as unknown as GeometryDescriptor);
    if (scopedArray.kind !== 'not-yet' || bareArray.kind !== 'not-yet')
      throw new Error('both array arms must refuse');
    for (const [label, v] of [
      ['scoped', scopedArray],
      ['unscoped', bareArray],
    ] as const) {
      expect(v.why, `${label}: blocked by the split count`).toContain('SPLIT vertex count');
      // Keyed on the retired CLAIM, never on the substring 'scope' — the message contains the
      // word 'scope' nowhere but the crude spelling of this assertion has reddened on correct
      // behaviour in this file before, which is the only reason it is spelled this way.
      expect(v.why, `${label}: must not cite the retired scope reason`).not.toContain(
        'half a polygon',
      );
      expect(v.why, `${label}: nor the triangle-addressing reason`).not.toContain(
        'addresses TRIANGLES',
      );
    }

    for (const d of [
      { kind: 'gltf', assetRef: 'a', childName: 'n' } as GeometryDescriptor,
      { kind: 'baked', hash: 'h', vertexCount: 10 } as GeometryDescriptor,
    ]) {
      const v = polygonLayoutOf(d);
      expect(v.kind, d.kind).toBe('outside-the-descriptor');
      // ...and it does NOT name an issue, because no issue makes an asset clone derivable.
      expect('until' in v, `${d.kind} must not promise a fix`).toBe(false);
    }
  });

  it('🔴 the gate rejects a layout with the right count and the WRONG diagonal', () => {
    // The detector's own detector ([[the fixture must red on a plausible wrong answer]]). A fan
    // from corner `a` over the same four vertices splits the cell along `a-c` instead of `b-d`:
    // six polygons, twelve triangles, full coverage, and two triangles per cell that three
    // never emitted. If this row cannot tell that apart, none of the rows above can either.
    const wrong = polygonsOf(box()).map((rim) => [rim[1], rim[2], rim[3], rim[0]]);
    const real = triples(new BoxGeometry(1, 1, 1).index!.array);
    const mine = triples(fanToTriangles(wrong));

    expect(mine.length, 'the wrong layout must still LOOK right by count').toBe(real.length);
    const mismatches = real.filter((t, i) => !rotations(t).includes(mine[i].join(','))).length;
    expect(mismatches, 'a wrong diagonal must be caught, not tolerated').toBeGreaterThan(0);
  });
});
