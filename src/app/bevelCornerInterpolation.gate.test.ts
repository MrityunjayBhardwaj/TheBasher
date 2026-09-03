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

/**
 * The worst distance any output corner lands OUTSIDE the uv range of the source face `pick` names
 * for it, with the denominators that say the walk was not vacuous.
 *
 * `pick` takes the FLAT output corner index, because that is the numbering both
 * `cornerRepresentative` and the uv buffer use — passing the face index too is what lets a
 * falsification swap the per-corner map for the face-wide one without touching anything else.
 */
function worstExcursion(
  ref: GeometryRef,
  pick: (layout: BevelLayout, face: number, at: number) => number,
  only: (layout: BevelLayout, face: number) => boolean = () => true,
): { worst: number; corners: number; faces: number } {
  const source = getForRead(bevelSourceOf(ref));
  if (source === null) throw new Error('no source');
  const sourceUv = source.getAttribute('uv');
  const layout = layoutOf(ref);
  const rims = sourceRims(ref, source.getAttribute('position').count);
  const faces = uvsByFace(ref);

  let worst = 0;
  let corners = 0;
  let examined = 0;
  let cursor = 0;
  for (let f = 0; f < faces.length; f++) {
    const base = cursor;
    cursor += faces[f].length;
    if (!only(layout, f)) continue;
    examined++;
    for (let c = 0; c < faces[f].length; c++) {
      const rep = rims[pick(layout, f, base + c)];
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
      const [u, v] = faces[f][c];
      worst = Math.max(worst, minU - u, u - maxU, minV - v, v - maxV, 0);
      corners++;
    }
  }
  return { worst, corners, faces: examined };
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
        // CONTAINED, not bounded (#880). This row used to allow a slack of 0.06 because a corner
        // was interpolated in a face it need not touch, which extrapolates. Given its OWN source
        // face the weights are non-negative, so a blend of values in `[0,1]` cannot leave `[0,1]`
        // — and the slack is float noise rather than a modelling allowance.
        expect(u).toBeGreaterThanOrEqual(-1e-9);
        expect(u).toBeLessThanOrEqual(1 + 1e-9);
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
        if (u === 0 && v === 0) atOrigin++;
      }
      // P6's discriminating observation, stated as a count rather than as a vibe: the minted
      // faces carry INTERPOLATED uvs rather than zeros. A few legitimate corners can land on
      // `(0,0)` — it is a real corner of a box face — so the claim is that the layer is not
      // MOSTLY the origin, which is what an unwritten buffer would be.
      expect(atOrigin).toBeLessThan(all.length / 2);
    });
  }

  it('a minted corner lands inside ITS OWN source face, exactly — the row a bound used to hold', () => {
    // 🔴 THIS ROW ASSERTED A SLACK OF 0.06, AND THE SLACK WAS THE DEFECT RATHER THAN THE LIMIT OF
    // MEASUREMENT. The reasoning it replaced ran: a minted corner sits on a source EDGE, the
    // representative is ONE of the faces meeting there, and on a non-planar quad the corner
    // projects slightly outside that face's rim — negative weights, so the blend extrapolates.
    // Every step of that is true. What was wrong was treating it as a planarity artefact to be
    // bounded, when it is a WRONG-FACE artefact to be removed: the corner has a face of its own,
    // and interpolating it there makes the weights non-negative by construction.
    //
    // The ceiling was measured BEFORE the fix existed, by brute force — for each corner try every
    // face incident to its source point and keep the best. That oracle reads EXACTLY 0 on every
    // shape and tessellation, against 2.13e-2 here for the face-wide map. No per-corner rule can
    // beat an oracle over all per-corner choices, so `< 1e-9` is the honest exit and a bound
    // would now be strictly weaker than what the code does.
    const ref = bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05);
    const { worst, corners, faces } = worstExcursion(
      ref,
      (l, _f, at) => l.cornerRepresentative[at],
    );
    // The denominators, as assertions: a walk that examined nothing reports the same silent zero.
    expect(faces).toBe(178);
    expect(corners).toBe(704);
    expect(worst).toBeLessThan(1e-9);
  });

  // ── The sweep, with AMOUNT HELD FIXED so tessellation is the only variable ──────────────
  //
  // 🔴 THE TABLE THAT USED TO SIT HERE MOVED TWO INPUTS AT ONCE and read a trend off the column:
  // it varied tessellation AND amount together (0.08 → 0.05 → 0.02) and concluded the error
  // "SHRINKS as tessellation refines", offered as the signature of a planarity artefact. Holding
  // `amount = 0.02` and moving only the tessellation, the worst excursion under the OLD face-wide
  // map GROWS monotonically — 6.14e-3 → 8.53e-3 → 9.10e-3 → 1.37e-2 → 1.78e-2 for edge quads
  // across 6x4 → 24x16. Consistent with the error scaling with chamfer size RELATIVE to source
  // face size, which refining at a fixed amount increases. The direction never mattered to the
  // fix, but the claim had reached a comment and was being read as established.
  //
  // These rows are the same sweep under the per-corner map, where every row is exactly 0. That is
  // what makes them worth keeping: the quantity that used to grow with refinement no longer
  // exists, so a regression toward the face-wide map reddens at EVERY tessellation, not just the
  // coarsest one somebody remembered to fixture.
  const FIXED_AMOUNT_SWEEP: [string, number, number][] = [
    ['6x4', 6, 4],
    ['8x6', 8, 6],
    ['12x8', 12, 8],
    ['16x12', 16, 12],
    ['24x16', 24, 16],
  ];

  for (const [name, w, h] of FIXED_AMOUNT_SWEEP) {
    it(`sphere ${name} at a fixed amount: every corner is inside its own source face, exactly`, () => {
      const ref = bevelGeometryRef(sphereGeometryRef(1, w, h, null), 0.02);
      const { worst, corners } = worstExcursion(ref, (l, _f, at) => l.cornerRepresentative[at]);
      expect(corners).toBeGreaterThan(0);
      expect(worst).toBeLessThan(1e-9);
    });
  }

  it("a PLANAR source is exact too, over every one of a bevelled cube's 26 faces", () => {
    // Kept from before the per-corner map, and it is not redundant with the rows above: a cube
    // was ALREADY exact under the face-wide map, because planar faces put every minted corner
    // inside whichever incident face was chosen. So this row is the control — it stays green
    // across the change, and if it ever reds the map is wrong rather than merely coarse.
    const ref = bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), 0.1);
    const { worst, corners, faces } = worstExcursion(
      ref,
      (l, _f, at) => l.cornerRepresentative[at],
    );
    expect(faces).toBe(26);
    expect(corners).toBe(96);
    expect(worst).toBeLessThan(1e-9);
  });

  it('a MAPPED face is exact on a non-planar source — its corners never leave their own face', () => {
    // Stated on its own rather than left inside the total. A mapped face is its own
    // representative under BOTH maps, so this quantity cannot be moved by the per-corner change;
    // a non-zero here would be a defect in the projection or the weights, and it would otherwise
    // hide inside a row whose headline number is dominated by minted faces.
    const ref = bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05);
    const { worst, corners, faces } = worstExcursion(
      ref,
      (l, _f, at) => l.cornerRepresentative[at],
      (l, f) => l.faceOrder[f] !== null,
    );
    expect(faces).toBe(48);
    // 176, not 48x4: a UV-sphere's pole rings are TRIANGLES. 16 pole tris x3 + 32 quads x4. The
    // figure was guessed as 192 when this row was written and the assertion caught it, which is
    // the whole reason a denominator is asserted rather than trusted.
    expect(corners).toBe(176);
    expect(worst).toBeLessThan(1e-9);
  });

  it('the per-corner map is NOT the face-wide one renamed — every minted face really does split', () => {
    // 🔴 WITHOUT THIS ROW THE WHOLE CHANGE COULD BE A NO-OP AND EVERY ROW ABOVE WOULD STILL PASS.
    // If `cornerRepresentative[at]` were just `representative[face]` broadcast to each corner, the
    // excursions would read exactly what they read before the fix — and on a cube, which is exact
    // either way, nothing at all would move. So the property asserted here is DISAGREEMENT: a
    // count of output faces whose corners do not all name the same source face.
    //
    // Pinned as a derived identity rather than a magic number: every MINTED face splits, and no
    // mapped face does. That is the strongest true form — an edge quad straddles two faces by
    // construction and a corner n-gon has one face per ring position, while a mapped face is its
    // own representative at every corner.
    for (const [name, ref] of [
      ['cube', bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), 0.1)],
      ['sphere', bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05)],
    ] as const) {
      const layout = layoutOf(ref);
      let split = 0;
      let cursor = 0;
      for (let f = 0; f < layout.corners.length; f++) {
        const base = cursor;
        cursor += layout.corners[f];
        const first = layout.cornerRepresentative[base];
        for (let c = 1; c < layout.corners[f]; c++) {
          if (layout.cornerRepresentative[base + c] !== first) {
            split++;
            break;
          }
        }
      }
      const minted = layout.corners.length - layout.sourceFaces;
      expect({ name, split }).toEqual({ name, split: minted });
      expect(minted).toBeGreaterThan(0);
      // And the map is exactly as long as the corner numbering it is indexed by.
      expect(layout.cornerRepresentative.length).toBe(cursor);
    }
  });

  it('on an all-edges bevel every n-gon ring position is ONE corner, so the tie-break never fires', () => {
    // The n-gon arm takes the LOWEST face index when a run of corners collapses into one ring
    // position. On an all-edges bevel no run is longer than one corner, so the choice is over a
    // single candidate and the tie-break is unexercised — which is why it can be simple, and why
    // that fact should have a reader rather than living in a comment. Observable from outside as:
    // an n-gon's corner sources are all DISTINCT. A run spanning two faces would name one of them
    // twice and drop the other.
    //
    // This row gains a reader the day a partial bevel makes runs longer than one, which is
    // exactly when somebody should look at the tie-break again.
    for (const [name, ref] of [
      ['cube', bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), 0.1)],
      ['sphere', bevelGeometryRef(sphereGeometryRef(1, 8, 6, null), 0.05)],
    ] as const) {
      const layout = layoutOf(ref);
      // An all-edges bevel mints one quad per source edge, so the n-gons are the tail after them.
      const ngonStart = layout.sourceFaces + layout.sourceEdges;
      let ngons = 0;
      let repeated = 0;
      let cursor = 0;
      for (let f = 0; f < layout.corners.length; f++) {
        const base = cursor;
        cursor += layout.corners[f];
        if (f < ngonStart) continue;
        ngons++;
        const reps = new Set<number>();
        for (let c = 0; c < layout.corners[f]; c++) reps.add(layout.cornerRepresentative[base + c]);
        if (reps.size !== layout.corners[f]) repeated++;
      }
      expect({ name, ngons: ngons > 0, repeated }).toEqual({ name, ngons: true, repeated: 0 });
    }
  });

  it('a PARTIAL bevel is exact too — the one case where the tie-break actually fires', () => {
    // The row above says the lowest-index tie-break is unexercised on an all-edges bevel. This is
    // the case where it IS exercised: chamfer only some edges and a point's corners fall into runs
    // that span more than one source face, so a ring position has several candidates and the rule
    // decides. It was filed as a risk on the grounds that a chosen-not-derived source might
    // reintroduce the excursion the per-corner map removes.
    //
    // Measured: it does not. Every scope a partial bevel can currently be built with reads exactly
    // zero, so the claim stays sharp rather than falling back to a bound.
    //
    // ⚠️ AND THE LIMIT OF THAT, STATED. A partial bevel is only buildable on a box today (#830),
    // and a box is PLANAR — so these rows confirm the tie-break does not break exactness, and do
    // NOT establish it on a non-planar source. They cannot, until a partial bevel of one builds.
    for (const scope of ['0-3', '0', '0-2', '0,2,4']) {
      const ref = bevelGeometryRef(boxGeometryRef(UNIT_BOX, null), 0.1, scope);
      const { worst, corners } = worstExcursion(ref, (l, _f, at) => l.cornerRepresentative[at]);
      expect({ scope, exact: worst < 1e-9, walked: corners > 0 }).toEqual({
        scope,
        exact: true,
        walked: true,
      });
    }
  });
});

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
