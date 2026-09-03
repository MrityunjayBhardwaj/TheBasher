// #825 slice 2 — the interpolation leaf, held on PROPERTIES rather than on remembered outputs.
//
// ── WHY NOT A TABLE OF EXPECTED WEIGHTS ────────────────────────────────────────────────
//
// A frozen table of numbers taken from this implementation would pass forever, including for
// every wrong implementation that produced it. The properties below are things mean-value
// coordinates ARE, each of which a plausible mis-port breaks:
//
//   partition of unity   — a missing normalisation still returns finite, ordered weights.
//   linear precision     — blending the source CORNERS with the weights reproduces the
//                          destination point. It catches half-tangents paired with the wrong
//                          corner and an unnormalised sum.
//   in-plane rotation    — the SAME polygon turned about its own normal must give the SAME
//                          weights. This is the row that catches a wrong projection basis.
//   the two hatches      — a naive mean-value port omits them entirely and still passes every
//                          row above on interior points, which is exactly why they are
//                          asserted separately and at the boundary rather than near it.
//
// 🔴 LINEAR PRECISION CANNOT CATCH A WRONG BASIS, AND THIS FILE CLAIMED IT COULD. Measured by
// falsification: scaling one basis axis by two — an anisotropic, non-orthonormal projection —
// left all fourteen rows GREEN. The reason is that linear precision survives any invertible
// linear map. If `w` are mean-value weights of `{T·vᵢ}` at `T·p` then `Σ wᵢ·(T·vᵢ) = T·p`, and
// because `T` is linear that rearranges to `Σ wᵢ·vᵢ = p` — the blended point comes back correct
// through a basis that is wrong. The individual WEIGHTS do change, so the property that sees it
// has to compare weights, not the point they reconstruct. Hence the rotation row below, which
// reds under exactly that edit.
//
// ⚠️ ROTATING THE POLYGON'S PLANE IS A DIFFERENT AND WEAKER CLAIM than rotating it WITHIN the
// plane, and only the second one bites. Also measured: the "same shape in another plane" row
// stayed green under the anisotropic basis, because both configurations were stretched along
// their own axes and the two results differed by a 180° turn, which mean-value weights are
// invariant to. Both rows are kept — they fail to different edits — but the in-plane one is the
// one carrying the basis.
//
// REF: src/app/polygonInterpolation.ts; ref/sources/blender-mesh/bmesh_interp.cc
//      (`BM_loop_interp_from_face`); Blender `math_geom.cc` (`interp_weights_poly_v2`:4334);
//      issue #825.

import { describe, expect, it } from 'vitest';
import {
  meanValueWeights2D,
  newellNormal,
  planarBasis,
  planarWeights,
} from './polygonInterpolation';

/** A square in the XY plane, wound CCW seen from +Z. */
const SQUARE_XY = new Float64Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);

/** A regular pentagon in the XY plane — an n-gon where n is neither 3 nor 4. */
const PENTAGON_XY = (() => {
  const out = new Float64Array(5 * 3);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    out[i * 3] = Math.cos(a);
    out[i * 3 + 1] = Math.sin(a);
    out[i * 3 + 2] = 0;
  }
  return out;
})();

function blend(polygon: Float64Array, n: number, weights: Float64Array): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    x += weights[i] * polygon[i * 3];
    y += weights[i] * polygon[i * 3 + 1];
    z += weights[i] * polygon[i * 3 + 2];
  }
  return [x, y, z];
}

function sum(weights: Float64Array, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  return total;
}

describe('#825 — newellNormal', () => {
  it('answers a unit normal oriented by the rim winding', () => {
    const out = new Float64Array(3);
    expect(newellNormal(SQUARE_XY, 4, out)).toBe(true);
    expect([...out]).toEqual([0, 0, 1]);

    // The SAME rim wound the other way is the opposite normal, which is the property
    // `builtFaceNormals` exists for and the one `rayMesh.faceNormalToward` deliberately lacks.
    const reversed = new Float64Array([-1, 1, 0, 1, 1, 0, 1, -1, 0, -1, -1, 0]);
    expect(newellNormal(reversed, 4, out)).toBe(true);
    expect([...out]).toEqual([0, 0, -1]);
  });

  it('refuses a rim with no area rather than inventing a direction', () => {
    const out = new Float64Array([9, 9, 9]);
    // Three collinear points — a rim, but not a plane.
    const collinear = new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect(newellNormal(collinear, 3, out)).toBe(false);
    // Untouched, so a caller cannot mistake a refusal for an answer it half-wrote.
    expect([...out]).toEqual([9, 9, 9]);
  });

  it('is area-weighted over the WHOLE rim, so a non-planar quad does not answer for one corner', () => {
    // A saddle quad: no three-corner cross product answers for it, and the two diagonals
    // disagree. Newell's sum is between them and is normal to neither triangle.
    const saddle = new Float64Array([-1, -1, 0.5, 1, -1, -0.5, 1, 1, 0.5, -1, 1, -0.5]);
    const out = new Float64Array(3);
    expect(newellNormal(saddle, 4, out)).toBe(true);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 12);
    // Symmetry pins it exactly: the saddle's z-displacements cancel in x and y.
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(1, 12);
  });
});

describe('#825 — planarBasis', () => {
  it('returns two orthonormal axes perpendicular to the normal, for a general direction', () => {
    const out = new Float64Array(6);
    const n = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    planarBasis(n[0], n[1], n[2], out);
    const u = [out[0], out[1], out[2]];
    const v = [out[3], out[4], out[5]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(u, u)).toBeCloseTo(1, 12);
    expect(dot(v, v)).toBeCloseTo(1, 12);
    expect(dot(u, v)).toBeCloseTo(0, 12);
    expect(dot(u, n)).toBeCloseTo(0, 12);
    expect(dot(v, n)).toBeCloseTo(0, 12);
  });

  it("takes the reference's degenerate branch when the normal is parallel to Z", () => {
    // `ortho_basis_v3v3_v3` tests `len_squared_v2(n)` — the first TWO components only — so a
    // +/-Z normal has no direction to build from and the basis is chosen outright.
    const out = new Float64Array(6);
    planarBasis(0, 0, 1, out);
    expect([...out]).toEqual([1, 0, 0, 0, 1, 0]);
    planarBasis(0, 0, -1, out);
    expect([...out]).toEqual([-1, 0, 0, 0, 1, 0]);
  });
});

describe('#825 — planarWeights: the properties mean-value coordinates HAVE', () => {
  const scratch = new Float64Array(16);

  it('sums to one and reproduces the destination, at the centre of a square', () => {
    const w = new Float64Array(4);
    const normal = new Float64Array([0, 0, 1]);
    expect(planarWeights(SQUARE_XY, 4, normal, 0, 0, 0, w, scratch)).toBe(true);
    expect(sum(w, 4)).toBeCloseTo(1, 12);
    // By symmetry every corner is worth the same at the centre.
    for (let i = 0; i < 4; i++) expect(w[i]).toBeCloseTo(0.25, 12);
    const [x, y, z] = blend(SQUARE_XY, 4, w);
    expect([x, y, z].map((c) => Number(c.toFixed(12)))).toEqual([0, 0, 0]);
  });

  it('has LINEAR PRECISION at interior points of a pentagon — and cannot see the basis', () => {
    const w = new Float64Array(5);
    const normal = new Float64Array(3);
    expect(newellNormal(PENTAGON_XY, 5, normal)).toBe(true);

    // Interior points chosen off every axis of symmetry, so a transposed or swapped basis
    // cannot coincidentally reproduce them.
    const probes: [number, number][] = [
      [0.1, 0.2],
      [-0.3, 0.15],
      [0.42, -0.11],
      [0, 0],
    ];
    for (const [px, py] of probes) {
      expect(planarWeights(PENTAGON_XY, 5, normal, px, py, 0, w, scratch)).toBe(true);
      expect(sum(w, 5)).toBeCloseTo(1, 10);
      // Mean-value coordinates are positive inside a convex polygon.
      for (let i = 0; i < 5; i++) expect(w[i]).toBeGreaterThan(0);
      const [x, y, z] = blend(PENTAGON_XY, 5, w);
      expect(x).toBeCloseTo(px, 10);
      expect(y).toBeCloseTo(py, 10);
      expect(z).toBeCloseTo(0, 10);
    }
  });

  it('is invariant to an IN-PLANE turn — the row that actually carries the projection basis', () => {
    // Turn the pentagon about its own normal by an angle that is not a symmetry of it, and turn
    // the destination with it. A correct orthonormal basis makes this a pure 2D rotation, which
    // mean-value weights are invariant to, so every weight must come back identical.
    //
    // 🔴 THIS REDS UNDER AN ANISOTROPIC BASIS AND NOTHING ELSE IN THIS FILE DOES — measured by
    // scaling one axis by two, which left the other thirteen rows green. A stretched projection
    // turns an in-plane rotation into a genuine change of shape, so the two weight sets diverge.
    const angle = 0.7; // radians; deliberately not 2π/5 or any multiple of it
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const turned = new Float64Array(5 * 3);
    for (let i = 0; i < 5; i++) {
      const x = PENTAGON_XY[i * 3];
      const y = PENTAGON_XY[i * 3 + 1];
      turned[i * 3] = x * cos - y * sin;
      turned[i * 3 + 1] = x * sin + y * cos;
      turned[i * 3 + 2] = 0;
    }
    const px = 0.31;
    const py = -0.17;

    const before = new Float64Array(5);
    const after = new Float64Array(5);
    const normal = new Float64Array(3);
    expect(newellNormal(PENTAGON_XY, 5, normal)).toBe(true);
    expect(planarWeights(PENTAGON_XY, 5, normal, px, py, 0, before, scratch)).toBe(true);
    expect(newellNormal(turned, 5, normal)).toBe(true);
    expect(
      planarWeights(turned, 5, normal, px * cos - py * sin, px * sin + py * cos, 0, after, scratch),
    ).toBe(true);

    for (let i = 0; i < 5; i++) expect(after[i]).toBeCloseTo(before[i], 10);
  });

  it('is invariant to the plane the polygon sits in — the same shape, rotated, answers the same', () => {
    // Rotate the pentagon 90 degrees about X so it lies in the XZ plane. The weights for the
    // correspondingly rotated destination must be identical: nothing about a mean-value weight
    // depends on which way the face happens to point.
    const rotated = new Float64Array(5 * 3);
    for (let i = 0; i < 5; i++) {
      rotated[i * 3] = PENTAGON_XY[i * 3];
      rotated[i * 3 + 1] = -PENTAGON_XY[i * 3 + 2];
      rotated[i * 3 + 2] = PENTAGON_XY[i * 3 + 1];
    }
    const flat = new Float64Array(5);
    const turned = new Float64Array(5);
    const nFlat = new Float64Array(3);
    const nTurned = new Float64Array(3);
    expect(newellNormal(PENTAGON_XY, 5, nFlat)).toBe(true);
    expect(newellNormal(rotated, 5, nTurned)).toBe(true);

    expect(planarWeights(PENTAGON_XY, 5, nFlat, 0.31, -0.17, 0, flat, scratch)).toBe(true);
    expect(planarWeights(rotated, 5, nTurned, 0.31, 0, -0.17, turned, scratch)).toBe(true);
    for (let i = 0; i < 5; i++) expect(turned[i]).toBeCloseTo(flat[i], 10);
  });

  it('refuses an unusable normal instead of guessing an axis', () => {
    const w = new Float64Array([7, 7, 7, 7]);
    expect(planarWeights(SQUARE_XY, 4, new Float64Array([0, 0, 0]), 0, 0, 0, w, scratch)).toBe(
      false,
    );
    expect([...w]).toEqual([7, 7, 7, 7]);
    expect(planarWeights(SQUARE_XY, 4, new Float64Array([NaN, 0, 1]), 0, 0, 0, w, scratch)).toBe(
      false,
    );
    expect([...w]).toEqual([7, 7, 7, 7]);
  });
});

describe('#825 — the two escape hatches, which a naive mean-value port omits', () => {
  const scratch = new Float64Array(16);

  it('IS_POINT_IX: a destination ON a source corner takes that corner whole', () => {
    const w = new Float64Array(4);
    const normal = new Float64Array([0, 0, 1]);
    for (let corner = 0; corner < 4; corner++) {
      const ok = planarWeights(
        SQUARE_XY,
        4,
        normal,
        SQUARE_XY[corner * 3],
        SQUARE_XY[corner * 3 + 1],
        SQUARE_XY[corner * 3 + 2],
        w,
        scratch,
      );
      expect(ok).toBe(true);
      const expected = [0, 0, 0, 0];
      expected[corner] = 1;
      expect([...w]).toEqual(expected);
    }
  });

  it('IS_SEGMENT_IX: a destination ON a source edge is a LINEAR blend of that edge alone', () => {
    const w = new Float64Array(4);
    const normal = new Float64Array([0, 0, 1]);

    // Midpoint of the edge from corner 0 (-1,-1) to corner 1 (1,-1).
    expect(planarWeights(SQUARE_XY, 4, normal, 0, -1, 0, w, scratch)).toBe(true);
    expect(w[0]).toBeCloseTo(0.5, 12);
    expect(w[1]).toBeCloseTo(0.5, 12);
    // 🔴 THE OTHER TWO ARE EXACTLY ZERO, NOT MERELY SMALL. That is the difference between the
    // hatch and the barycentric branch: mean-value weights at a point on the boundary tend
    // toward the far corners' zero but do not reach it, so a port that dropped the hatch would
    // pass a `toBeCloseTo` here and fail this.
    expect(w[2]).toBe(0);
    expect(w[3]).toBe(0);

    // A quarter along the same edge, to pin the FACTOR and not just the symmetry — a hatch that
    // always split 50/50 would pass the row above.
    expect(planarWeights(SQUARE_XY, 4, normal, -0.5, -1, 0, w, scratch)).toBe(true);
    expect(w[0]).toBeCloseTo(0.75, 12);
    expect(w[1]).toBeCloseTo(0.25, 12);
    expect(w[2]).toBe(0);
    expect(w[3]).toBe(0);
  });

  it('IS_SEGMENT_IX fires on the CLOSING edge too, which the loop reaches first', () => {
    // The walk starts at `iCurr = n - 1`, so the edge from the LAST corner to the first is the
    // first segment tested. An off-by-one in the initial half-tangent shows up here and nowhere
    // else in this file.
    const w = new Float64Array(4);
    const normal = new Float64Array([0, 0, 1]);
    // Midpoint of the edge from corner 3 (-1,1) to corner 0 (-1,-1).
    expect(planarWeights(SQUARE_XY, 4, normal, -1, 0, 0, w, scratch)).toBe(true);
    expect(w[3]).toBeCloseTo(0.5, 12);
    expect(w[0]).toBeCloseTo(0.5, 12);
    expect(w[1]).toBe(0);
    expect(w[2]).toBe(0);
  });

  it('the hatch is SCALE-RELATIVE, so it fires the same way on a mesh a thousand times larger', () => {
    // `eps = 16 * FLT_EPSILON * max_value`. A fixed epsilon would miss the corner on a large
    // mesh and swallow the interior on a small one; this asserts the same answer at both ends.
    const w = new Float64Array(4);
    const normal = new Float64Array([0, 0, 1]);
    for (const scale of [1e-3, 1, 1e3]) {
      const scaled = new Float64Array(SQUARE_XY.length);
      for (let i = 0; i < SQUARE_XY.length; i++) scaled[i] = SQUARE_XY[i] * scale;
      expect(planarWeights(scaled, 4, normal, 0, -scale, 0, w, scratch)).toBe(true);
      expect(w[0]).toBeCloseTo(0.5, 10);
      expect(w[1]).toBeCloseTo(0.5, 10);
      expect(w[2]).toBe(0);
      expect(w[3]).toBe(0);
    }
  });
});

describe('#825 — meanValueWeights2D degenerate answers', () => {
  it('leaves an all-zero weight set unnormalised rather than emitting NaN', () => {
    // A polygon whose corners are all collinear WITH the destination carries no angle at all.
    // Dividing by the zero total would put NaNs into an attribute buffer and draw them.
    const collinear = new Float64Array([1, 0, 2, 0, 3, 0]);
    const w = new Float64Array(3);
    meanValueWeights2D(collinear, 3, 10, 0, w);
    for (let i = 0; i < 3; i++) expect(Number.isFinite(w[i])).toBe(true);
  });
});
