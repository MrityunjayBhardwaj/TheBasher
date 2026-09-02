// #825 slice 2 — a bevel carries its source's UVs, and the oracle is a CLOSED FORM.
//
// ── WHAT THIS HOLDS THAT "IT HAS A `uv` ATTRIBUTE" DOES NOT ────────────────────────────
//
// 🔴 THE PRESENCE OF A LAYER IS NOT THE ANSWER TO ANY QUESTION WORTH ASKING, and this arc has
// already paid for reading a count as a verdict once (#875 was filed, and closed invalid the
// same hour, on a helper that counted `position.count` for a face SUBSET — the one quantity a
// subset does not move). A zeroed `uv` of the right length passes every shape-level check there
// is, draws, and is wrong. So every row below asserts VALUES against a form derived from what a
// chamfer IS, never from what the builder happens to emit.
//
// THE CLOSED FORM. `mintedBevel.gate.test.ts` establishes that a unit cube chamfered by `a` has
// exactly the 24 points permuting `(±0.5, ±(0.5 − a), ±(0.5 − a))`. A `BoxGeometry` face carries
// a uv that is LINEAR over `[−0.5, 0.5] → [0, 1]` in both of its in-face directions. Those two
// facts together predict a bevelled cube's uvs with no reference to this implementation:
//
//   a MAPPED face   — its four corners moved inward by `a` in both in-face directions, so its
//                     uvs are exactly the four combinations of `{a, 1 − a}`.
//   an EDGE QUAD    — two of its corners lie in its representative face's plane at that same
//                     inset, and the other two project ONTO that face's boundary edge, where
//                     `interp_weights_poly_v2`'s segment hatch fires exactly. So the strip
//                     carries `{a, 1 − a}` on one side and `{0, 1}` on the other, continuing the
//                     source face's parametrisation across the chamfer.
//
// ⚠️ THE MAPPED ROW IS A JOINT CLAIM AND THAT IS WHY IT IS SHARP. Reproducing a linear function
// exactly is a property mean-value coordinates HAVE on a convex polygon; getting `{a, 1 − a}`
// therefore tests the projection, the weights and the blend together. A copy — of the
// representative's first corner, or of any single corner — gives a constant per face and reds it.
//
// REF: src/app/polygonInterpolation.ts (the weights, and its own gate);
//      src/app/geometryRegistry.ts (`buildBevel` — where the uv is written, and why it can only
//      be written there); src/app/mintedBevel.gate.test.ts (the 24-point closed form this
//      builds on); ref/sources/blender-mesh/bmesh_bevel.cc (`bev_create_ngon`:1236);
//      issues #825, #814.

import { describe, expect, it, beforeEach } from 'vitest';
import { boxGeometryRef, sphereGeometryRef, bevelGeometryRef } from './modifierGeometry';
import { clear, getForRead } from './geometryRegistry';
import { bevelLayoutOf, type BevelLayout } from './bevelLayout';
import { alignedSplitRims } from './builtRims';
import type { GeometryRef } from '../nodes/types';

function layoutOf(ref: GeometryRef): BevelLayout {
  const verdict = bevelLayoutOf(ref.descriptor);
  if (verdict.kind !== 'laid-out') throw new Error(`expected a layout, got: ${verdict.why}`);
  return verdict.layout;
}

/** Every output face's corner uvs, grouped — the buffer is one split vertex per output corner. */
function uvsByFace(ref: GeometryRef): [number, number][][] {
  const geometry = getForRead(ref);
  if (geometry === null) throw new Error('no build');
  const uv = geometry.getAttribute('uv');
  if (uv === undefined) throw new Error('no uv attribute');
  const layout = layoutOf(ref);
  const faces: [number, number][][] = [];
  let cursor = 0;
  for (const n of layout.corners) {
    const face: [number, number][] = [];
    for (let k = 0; k < n; k++) face.push([uv.getX(cursor + k), uv.getY(cursor + k)]);
    faces.push(face);
    cursor += n;
  }
  return faces;
}

const UNIT_BOX = [1, 1, 1] as never;

describe('#825 slice 2 — a bevel carries a uv layer at all', () => {
  beforeEach(() => clear());

  it('emits one uv per output CORNER, on a cube and on a mixed-arity sphere', () => {
    for (const ref of [
      bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), 0.1),
      bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05),
    ]) {
      const geometry = getForRead(ref);
      expect(geometry).not.toBeNull();
      const uv = geometry?.getAttribute('uv');
      const position = geometry?.getAttribute('position');
      expect(uv).toBeDefined();
      // 🔴 AGAINST THE CORNER COUNT, NOT AGAINST ITSELF. In three.js `uv` is per split vertex,
      // which is a CORNER, and a bevel splits every one — so the layer is the same length as
      // `position`. Asserting `uv.count > 0` would pass for a one-entry buffer.
      expect(uv?.count).toBe(position?.count);
      expect(uv?.count).toBe(layoutOf(ref).corners.reduce((sum, n) => sum + n, 0));
    }
  });

  it('does NOT emit a uv layer when the source has none — absence is not zeros', () => {
    // Nothing in this repo builds a primitive without UVs, so the source is constructed: a
    // bevel of a bevel, whose inner build is the only uv-less geometry available... and it is
    // not, since #825. So the property is asserted the other way round, on the ONE thing that
    // can still be observed — that the layer a bevel emits is its source's, not an invention.
    // A source with no uv would give `uv === undefined`, which is what `UVAttributeVerdict`
    // reads as `none` rather than as "UVs at the origin".
    const inner = bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), 0.1);
    const outer = bevelGeometryRef(inner, 0.02);
    const geometry = getForRead(outer);
    expect(geometry?.getAttribute('uv')).toBeDefined();
  });
});

describe('#825 slice 2 — the closed form a unit cube predicts', () => {
  beforeEach(() => clear());

  for (const a of [0.05, 0.1, 0.25]) {
    it(`a MAPPED face's uvs are exactly the {a, 1-a} inset at amount ${a}`, () => {
      const ref = bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), a);
      const layout = layoutOf(ref);
      const faces = uvsByFace(ref);

      const mapped = faces.filter((_, f) => layout.faceOrder[f] !== null);
      // Six, and stated rather than assumed: a cube has six faces and every one of them maps.
      expect(mapped.length).toBe(6);

      const expected = new Set([
        `${a},${a}`,
        `${a},${1 - a}`,
        `${1 - a},${a}`,
        `${1 - a},${1 - a}`,
      ]);
      for (const face of mapped) {
        expect(face.length).toBe(4);
        const seen = new Set(face.map(([u, v]) => `${round(u)},${round(v)}`));
        // All four combinations, each exactly once — a face that collapsed onto one corner's
        // value would have a single member here and a copy of the whole rim would have four
        // that are the SOURCE's `{0,1}` rather than the inset.
        expect(seen).toEqual(expected);
      }
    });
  }

  it('an EDGE QUAD continues its representative face across the chamfer', () => {
    const a = 0.1;
    const ref = bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), a);
    const layout = layoutOf(ref);
    const faces = uvsByFace(ref);

    const quads = faces.filter((_, f) => layout.faceOrder[f] === null && layout.corners[f] === 4);
    // Twelve edges on a cube, each minting one quad.
    expect(quads.length).toBe(12);

    for (const quad of quads) {
      const values = quad.map(([u, v]) => [round(u), round(v)]);
      // 🔴 EVERY COMPONENT IS ONE OF FOUR NUMBERS, AND THE SET IS THE ASSERTION. Two corners sit
      // at the inset (`a` or `1 - a`) inside the representative's plane; the other two project
      // onto that face's BOUNDARY, where the segment hatch pins them to `0` or `1` exactly. A
      // mean-value result at a boundary point tends toward the edge without reaching it, so a
      // port that dropped the hatch would land near `0.9997` and red this row.
      for (const [u, v] of values) {
        expect([0, a, 1 - a, 1]).toContain(u);
        expect([0, a, 1 - a, 1]).toContain(v);
      }
      // And it is a real strip, not a collapsed one: at least two DISTINCT uvs per quad.
      expect(new Set(values.map(([u, v]) => `${u},${v}`)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('the inset TRACKS the amount, so the uvs are a function of the geometry and not a constant', () => {
    // The row that catches a plausible constant. Three amounts, three different uv sets — a
    // builder that emitted the source's uvs unchanged would give the same set for all three.
    const seen = new Set<string>();
    for (const a of [0.05, 0.1, 0.25]) {
      clear();
      const ref = bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), a);
      const layout = layoutOf(ref);
      const mapped = uvsByFace(ref).filter((_, f) => layout.faceOrder[f] !== null);
      seen.add(
        [...new Set(mapped.flat().map(([u, v]) => `${round(u)},${round(v)}`))].sort().join('|'),
      );
    }
    expect(seen.size).toBe(3);
  });
});

describe('#825 slice 2 — what must hold for ANY source, not just a cube', () => {
  beforeEach(() => clear());

  const cases: [string, () => GeometryRef][] = [
    ['bevelled cube', () => bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), 0.1)],
    ['bevelled sphere', () => bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05)],
    ['bevelled sphere, coarse', () => bevelGeometryRef(sphereGeometryRef(2, 6, 4, null), 0.08)],
  ];

  for (const [name, make] of cases) {
    it(`${name}: every uv is finite, in the source's range, and not the origin everywhere`, () => {
      const faces = uvsByFace(make());
      const all = faces.flat();
      expect(all.length).toBeGreaterThan(0);

      let atOrigin = 0;
      for (const [u, v] of all) {
        // 🔴 NaN IS THE FAILURE THIS SUBSTRATE FEARS MOST HERE. `interp_weights_poly_v2` leaves a
        // zero weight-total UNNORMALISED precisely so a degenerate polygon cannot put NaNs into
        // a vertex buffer, and a NaN uv does not draw wrong — it can take the mesh off screen.
        expect(Number.isFinite(u)).toBe(true);
        expect(Number.isFinite(v)).toBe(true);
        // BOUNDED rather than contained — see the `NON-PLANAR` block below for the measurement
        // that replaced the containment claim this row used to make.
        expect(u).toBeGreaterThanOrEqual(-EXTRAPOLATION_BOUND);
        expect(u).toBeLessThanOrEqual(1 + EXTRAPOLATION_BOUND);
        expect(v).toBeGreaterThanOrEqual(-EXTRAPOLATION_BOUND);
        expect(v).toBeLessThanOrEqual(1 + EXTRAPOLATION_BOUND);
        if (u === 0 && v === 0) atOrigin++;
      }
      // P6's discriminating observation, stated as a count rather than as a vibe: the minted
      // faces carry INTERPOLATED uvs rather than zeros. A few legitimate corners can land on
      // `(0,0)` — it is a real corner of a box face — so the claim is that the layer is not
      // MOSTLY the origin, which is what an unwritten buffer would be.
      expect(atOrigin).toBeLessThan(all.length / 2);
    });
  }

  it('a MINTED face stays within a MEASURED bound of its representative, and a PLANAR source is exact', () => {
    // 🔴 THIS ROW USED TO CLAIM STRICT CONTAINMENT AND THAT CLAIM WAS FALSE — measured, not
    // reasoned. The argument was that mean-value weights inside a convex polygon are positive
    // and sum to one, so a blend of values in `[0,1]` cannot leave it. Both premises fail here:
    // the destination is not always INSIDE its representative, and a projected source face is
    // not always CONVEX.
    //
    // Why, structurally. A minted corner sits on a source EDGE, and the representative is ONE of
    // the faces meeting there. On a cube — planar faces — every such corner projects inside its
    // representative and the answer is exact. On a sphere the quads are NOT planar, so the
    // Newell plane is an average no corner lies in, and a corner slightly off it projects
    // slightly outside the rim. Negative weights follow, and a blend with a negative weight
    // extrapolates.
    //
    // MEASURED, by face kind, across four shapes:
    //
    //   shape                | mapped | edge quad | corner n-gon
    //   cube        a=0.1    |      0 |         0 |            0
    //   sphere 8x6  a=0.05   |      0 |   1.46e-2 |      2.72e-2
    //   sphere 6x4  a=0.08   |      0 |   1.03e-2 |      1.64e-2
    //   sphere 16x12 a=0.02  |      0 |   9.34e-3 |      1.37e-2
    //
    // Three things that reading gives which "it extrapolates" does not: MAPPED faces are exact
    // on every shape (their corners cannot leave their own face, so a non-zero there would be a
    // real defect); a PLANAR source is exact everywhere; and the error SHRINKS as tessellation
    // refines, which is the signature of a planarity artefact rather than of a wrong map.
    //
    // 🔑 THE REFERENCE REMOVES BOTH CAUSES AND WE SHIP NEITHER MECHANISM YET. `bev_create_ngon`
    // can interpolate each corner from its OWN source face (`face_arr[i]`, `bmesh_bevel.cc:1259`)
    // instead of one representative for the whole face, and it SNAPS the destination onto its
    // edge before interpolating (`closest_to_line_segment_v3`, `:1274-1277`) so the segment hatch
    // fires exactly rather than nearly. Both are follow-up work and are filed as such; this slice
    // is the projection, the weights and the blend, which is what #825 scopes it to.
    const ref = bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05);
    const geometry = getForRead(ref);
    const layout = layoutOf(ref);
    if (geometry === null) throw new Error('no build');
    const source = getForRead(bevelSourceOf(ref));
    if (source === null) throw new Error('no source');
    const sourceUv = source.getAttribute('uv');
    const faces = uvsByFace(ref);

    // The source's rims, in the same split numbering `buildBevel` uses.
    const rims = sourceRims(ref, source.getAttribute('position').count);
    let checked = 0;
    for (let f = 0; f < faces.length; f++) {
      if (layout.faceOrder[f] !== null) continue;
      const rep = rims[layout.representative[f]];
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const corner of rep) {
        minU = Math.min(minU, sourceUv.getX(corner));
        maxU = Math.max(maxU, sourceUv.getX(corner));
        minV = Math.min(minV, sourceUv.getY(corner));
        maxV = Math.max(maxV, sourceUv.getY(corner));
      }
      for (const [u, v] of faces[f]) {
        expect(u).toBeGreaterThanOrEqual(minU - EXTRAPOLATION_BOUND);
        expect(u).toBeLessThanOrEqual(maxU + EXTRAPOLATION_BOUND);
        expect(v).toBeGreaterThanOrEqual(minV - EXTRAPOLATION_BOUND);
        expect(v).toBeLessThanOrEqual(maxV + EXTRAPOLATION_BOUND);
      }
      checked++;
    }
    // The denominator, printed as an assertion: a loop that examined nothing would otherwise
    // report the same silent success as one that examined every minted face.
    expect(checked).toBeGreaterThan(0);
  });

  it('a PLANAR source extrapolates by EXACTLY zero — the half of the bound that is sharp', () => {
    // The bound above is loose by design; this is the row that is not. A cube's faces are planar,
    // so every minted corner projects inside its representative and every weight is positive.
    // Anything non-zero here is a wrong representative or a wrong plane, not a planarity
    // artefact — and it would be invisible in the bounded row.
    const ref = bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), 0.1);
    const source = getForRead(bevelSourceOf(ref));
    if (source === null) throw new Error('no source');
    const sourceUv = source.getAttribute('uv');
    const layout = layoutOf(ref);
    const rims = sourceRims(ref, source.getAttribute('position').count);
    const faces = uvsByFace(ref);

    let worst = 0;
    let checked = 0;
    for (let f = 0; f < faces.length; f++) {
      const rep = rims[layout.representative[f]];
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const corner of rep) {
        minU = Math.min(minU, sourceUv.getX(corner));
        maxU = Math.max(maxU, sourceUv.getX(corner));
        minV = Math.min(minV, sourceUv.getY(corner));
        maxV = Math.max(maxV, sourceUv.getY(corner));
      }
      for (const [u, v] of faces[f]) {
        worst = Math.max(worst, minU - u, u - maxU, minV - v, v - maxV, 0);
      }
      checked++;
    }
    // All 26 output faces of a bevelled cube — mapped, edge quads and corner n-gons alike.
    expect(checked).toBe(26);
    expect(worst).toBeLessThan(1e-9);
  });
});

/**
 * How far outside its representative's uv range a minted corner may land.
 *
 * MEASURED at `2.72e-2` on the coarsest sphere this file builds and falling to `1.37e-2` at
 * 16x12 — see the block in the row above for the full table and the cause. The bound is set a
 * little over twice the worst observation rather than snugly against it: it exists to catch a
 * BROKEN representative map (which would put a value in a different face's range entirely,
 * typically 0.1 to 1.0 away), not to freeze the current numeric error, which is expected to fall
 * when the per-corner source and the edge snap land.
 */
const EXTRAPOLATION_BOUND = 0.06;

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function bevelSourceOf(ref: GeometryRef): GeometryRef {
  const d = ref.descriptor;
  if (d.kind !== 'bevel') throw new Error('not a bevel');
  return d.source;
}

/** The same rims `buildBevel` reads, so this gate cannot disagree with it about which corner is which. */
function sourceRims(ref: GeometryRef, splitCount: number): readonly (readonly number[])[] {
  const source = getForRead(bevelSourceOf(ref));
  if (source === null) throw new Error('no source');
  const rims = alignedSplitRims(bevelSourceOf(ref), source);
  if (rims === null) throw new Error('no rims');
  expect(rims.flat().every((c) => c >= 0 && c < splitCount)).toBe(true);
  return rims;
}
