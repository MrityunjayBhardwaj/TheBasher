// #817 — A BEVEL'S AMOUNT IS CLAMPED TO WHAT THE GEOMETRY CAN ACCOMMODATE.
//
// ── WHAT WAS WRONG, AND WHY NO COUNT COULD SEE IT ─────────────────────────────────────
//
// A bevel pulls each corner back along its rim edges. Past half the shortest incident edge two
// chamfered corners CROSS, and the result is a self-intersecting shell. #814 refused a
// non-positive amount and left the upper end open by decision.
//
// The failure was invisible to every instrument we had, measured three ways:
//
//   1. THE POINT COUNT COMES BACK RIGHT. On a unit cube, 0.5 collapsed corners onto face centres
//      (24 -> 6, which the parity check caught) but 0.9 overshot PAST them and welded to 24
//      again. The one amount that warned was the one exactly at the crossing.
//   2. THE BOUNDING BOX NEVER GREW. Corners slide INWARD along rim edges, so the extent stays
//      0.5 on a unit cube even at 0.9. No extent check could have seen it.
//   3. 🔴 ON A GENERAL MESH NOTHING WARNED AT ALL. A sphere overshot at every amount from 0.2 up
//      and welded to 176 throughout, because a weld anomaly needs corners to land EXACTLY on one
//      another — which only symmetry produces. The cube's 0.5 was a symmetry artifact, so the
//      "the existing instrument catches the middle case" reading held for the cube and for
//      nothing else.
//
// ── CLAMP, NOT REFUSE, AND BOTH REFERENCES SAY SO ─────────────────────────────────────
//
// Blender clamps by default — `do_clamp = !(bmd->flags & MOD_BEVEL_OVERLAP_OK)`
// (`MOD_bevel.cc:130`), so overlap is the opt-in. Houdini's PolyBevel says it in words under
// *Detect Collisions*: *"when two adjacent points in the offset front collide, stop the points
// there (don't move the points past each other, creating overlap)"*. Neither refuses.
//
// And a refusal would repeat #862: `amount` carries a scrub handle, so a refusal is a cliff an
// author reaches by DRAGGING rather than by typing something unreasonable.
//
// ── THE CLAMP IS GLOBAL AND UNIFORM, AND IT STOPS AT THE COLLISION ITSELF ─────────────
//
// `bevel_limit_offset` (`bmesh_bevel.cc:8186`) takes the MINIMUM over every beveled vertex and
// scales EVERY offset spec by one ratio (`:8211-8230`) — the whole bevel shrinks together. There
// is no epsilon anywhere in that path; the `BEVEL_EPSILON` tests inside `geometry_collide_offset`
// (`:8093`, `:8095`) guard a near-zero DENOMINATOR, not the returned value.
//
// 🔴 MEASURED IN THE RUNNING REFERENCE, because the instinct here was to stop just short so that
// coincident positions never occur. Blender 5.1.1, unit cube, clamp overlap ON:
//
//     amount 0.4 -> 24 vertices / 24 distinct positions
//     amount 0.5, 0.6, 0.9, 2.0 -> 24 vertices / 6 distinct positions, every one of them
//
// So the reference's clamped output LIVES in the coincident state rather than avoiding it, and
// stopping short would have diverged from it to keep one of our own warnings quiet. Row 5 is
// what that cost instead: `pointCountMismatch` had to learn the case.
//
// REF: src/app/geometryRegistry.ts (`clampOverlapLimit`, and the stamp it writes);
//      src/app/pointIdentity.ts (`pointCountMismatch`, the one-sided exemption);
//      ref/sources/blender-mesh/bmesh_bevel.cc:8012, :8186; MOD_bevel.cc:130;
//      https://www.sidefx.com/docs/houdini/nodes/sop/polybevel.html; issues #817, #814, #862.

import { beforeEach, describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { bevelGeometryRef, boxGeometryRef, sphereGeometryRef } from './modifierGeometry';
import { clear, getForRead } from './geometryRegistry';
import { pointCountMismatch, pointCountOf, weldByPosition } from './pointIdentity';

const UNIT = [1, 1, 1] as [number, number, number];

/** Distinct welded positions of a bevel at `amount`, built through the real registry. */
function welds(source: ReturnType<typeof boxGeometryRef>, amount: number): number {
  clear();
  return weldByPosition(getForRead(bevelGeometryRef(source, amount))!).points;
}

/** Every position of a bevel at `amount`, in buffer order. */
function coords(source: ReturnType<typeof boxGeometryRef>, amount: number): number[] {
  clear();
  const g = getForRead(bevelGeometryRef(source, amount))!;
  const p = g.getAttribute('position');
  const out: number[] = [];
  for (let i = 0; i < p.count; i++) out.push(p.getX(i), p.getY(i), p.getZ(i));
  return out;
}

/**
 * Do two builds describe the same geometry?
 *
 * ⚠️ A TOLERANCE, AND THE FIRST SPELLING OF THIS ROW USED EXACT STRINGS AND WAS WRONG. Comparing
 * `toFixed(6)` text made two genuinely-equal builds differ by the SIGN OF ZERO: an amount typed
 * exactly at the limit is applied unclamped, while any larger amount is replaced by the computed
 * limit, and the two differ by one ulp — enough for `0.15 - 0.15` to be `+0` on one road and
 * `-2.8e-17` on the other. Both render identically. A positional claim needs a positional
 * comparison, so the row says what it means instead of pinning float text.
 *
 * ⚠️ AND THE TOLERANCE IS SIZED TO THE BUFFER, NOT CHOSEN. `buildBevel` writes a
 * `Float32Array`, which carries about seven decimal digits — so `1e-9` is tighter than the
 * storage can represent and rejected two builds that ARE equal, including `0.5 - 0.1` against a
 * literal `0.4`. `1e-6` is comfortably above float32's resolution at these magnitudes and far
 * below any difference a real clamp failure would produce (the overshoot this issue is about
 * moves corners by tenths).
 */
function same(a: number[], b: number[], tol = 1e-6): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

beforeEach(() => clear());

describe('#817 — the amount is clamped to what the geometry can accommodate', () => {
  it('1 — THE INSTRUMENT CONTROL: the probe spans both sides of the limit', () => {
    // Without this every row below could pass while every amount landed on the same side.
    const box = boxGeometryRef(UNIT, null);
    expect({ below: welds(box, 0.4), at: welds(box, 0.5) }).toEqual({ below: 24, at: 6 });
  });

  it('2 — 🔴 THE CLAIM: past the limit is INDISTINGUISHABLE from the limit', () => {
    // The whole issue, inverted. 0.9 used to weld to 24 — corners overshot past each other and
    // the count came back right, so nothing warned. It must now be the SAME GEOMETRY as 0.5,
    // which is a stronger statement than "the count matches": every coordinate is compared.
    const box = boxGeometryRef(UNIT, null);
    const atLimit = coords(box, 0.5);
    for (const over of [0.51, 0.9, 2, 1000]) {
      expect(
        same(coords(box, over), atLimit),
        `amount ${over} must be clamped back to the limit`,
      ).toBe(true);
    }
    // And the clamped builds are identical to EACH OTHER exactly, not merely within tolerance —
    // they are all the same computed limit, so nothing but the author's number differed.
    expect(coords(box, 0.9)).toEqual(coords(box, 1000));
  });

  it('3 — BELOW the limit nothing moved, so the clamp is invisible to every valid bevel', () => {
    // The half that stops this being a behaviour change for anyone using the operator sanely.
    // These are the coordinates #814 and #827 already pinned; the clamp must not touch them.
    const box = boxGeometryRef(UNIT, null);
    expect(welds(box, 0.1)).toBe(24);
    expect(welds(box, 0.4)).toBe(24);
    expect(welds(box, 0.49)).toBe(24);
    // The +X face's corners sit at `0.5 - amount` on both other axes — #818's closed form, which
    // is what says the chamfer still has the shape it had, not merely the right point count.
    const near = (xs: number[], v: number) => xs.some((x) => Math.abs(x - v) < 1e-6);
    expect(near(coords(box, 0.1), 0.4), 'the +X face’s corners sit at 0.5 - amount').toBe(true);
    expect(near(coords(box, 0.3), 0.2), 'and again at a larger legal amount').toBe(true);
  });

  it('4 — 🔑 THE LIMIT IS GLOBAL AND UNIFORM: the SHORTEST edge governs the WHOLE bevel', () => {
    // The reference scales every offset spec by ONE ratio, so a bevel shrinks together rather
    // than per corner. A per-corner clamp would leave the long edges chamfered further than the
    // short ones — a chamfer of varying width, which neither reference produces.
    //
    // A 1 x 0.3 x 1 box: the shortest edge is 0.3, so the limit is 0.15 EVERYWHERE, including
    // along the edges of length 1 that could individually have taken 0.5.
    const slab = boxGeometryRef([1, 0.3, 1], null);
    expect(welds(slab, 0.14), 'below the shortest edge’s limit').toBe(24);
    const atLimit = coords(slab, 0.15);
    for (const over of [0.16, 0.3, 0.5, 2]) {
      expect(same(coords(slab, over), atLimit), `slab at ${over} clamps to the SHORTEST edge`).toBe(
        true,
      );
    }
    // And the governing number really is the short edge's half, not the long one's: 0.4 would be
    // a legal amount if each edge were clamped on its own, and it is not legal here.
    expect(same(coords(slab, 0.4), atLimit)).toBe(true);
  });

  it('5 — the parity check accepts a clamped bevel welding LOWER, and ONLY lower', () => {
    // 🔴 THE EXEMPTION THAT COULD SWALLOW A REAL DISAGREEMENT, PINNED AS ONE-SIDED.
    // A clamped bevel legitimately welds below its derived count — that is what meeting corners
    // means, and it is the reference's own output. But merging can only ever REDUCE distinct
    // positions, so a build welding ABOVE its derived count is impossible by clamping and is
    // exactly the drift this check exists for. The exemption must not reach it.
    const box = boxGeometryRef(UNIT, null);
    const ref = bevelGeometryRef(box, 0.9);
    clear();
    const built = getForRead(ref)!;
    const derived = pointCountOf(ref.descriptor);
    expect(derived.kind).toBe('counted');

    // It is stamped, it welds low, and it is silent.
    expect(typeof built.userData.bevelCollisionLimit, 'the build carries the limit').toBe('number');
    expect(weldByPosition(built).points).toBeLessThan(
      derived.kind === 'counted' ? derived.count : 0,
    );
    expect(pointCountMismatch(ref.descriptor, built, () => null)).toBeNull();

    // 🔴 THE MUST-RED. Same descriptor, same stamp, but a geometry welding ABOVE the derived
    // count — the direction no clamp can produce. Still reported, or the exemption is a hole.
    const tooMany = new BufferGeometry();
    const n = (derived.kind === 'counted' ? derived.count : 0) + 5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) xs.push(i * 10, 0, 0);
    tooMany.setAttribute('position', new Float32BufferAttribute(xs, 3));
    tooMany.userData.bevelCollisionLimit = 0.5;
    expect(pointCountMismatch(ref.descriptor, tooMany, () => null)).toMatch(/welds to/);

    // And an UNSTAMPED bevel is not exempt either, so the stamp is doing the work rather than
    // the descriptor kind.
    const unstamped = new BufferGeometry();
    unstamped.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    expect(pointCountMismatch(ref.descriptor, unstamped, () => null)).toMatch(/welds to/);
  });

  it('6 — a mesh whose edges differ is clamped too, where no weld anomaly ever appeared', () => {
    // The case that had NO instrument at all: a sphere overshoots without ever producing
    // coincident positions, so no count anywhere moved. The clamp is what makes it observable —
    // past the limit the geometry stops changing, which is a claim a count could not make.
    const sphere = sphereGeometryRef(1, 8, 6, null);
    const atLimit = coords(sphere, 0.5);
    for (const over of [1, 5, 100]) {
      expect(same(coords(sphere, over), atLimit), `sphere at ${over} is clamped`).toBe(true);
    }
    // And a small amount is untouched — the row above would pass vacuously if everything clamped.
    expect(same(coords(sphere, 0.05), atLimit)).toBe(false);
  });
});
