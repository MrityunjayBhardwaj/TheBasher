// #638 (ns-1b step 2) — the face index becomes a group layout, at POLYGON granularity (#770).
//
// The load-bearing assertion in this file is the group BOUNDARY on a MIXED-ARITY layout, not
// coverage. Coverage is 240 of 240 whether an implementation reads each polygon's real arity or
// assumes every one is a quad; only `start: 3` tells the two apart. Everything else here exists
// to stop that assertion being weakened later by someone who reads coverage as sufficient.
//
// ⚠️ IT WAS A BOX AND HAD TO STOP BEING ONE. The predecessor discriminator was a box with face 0
// alone on slot 1, asserting `start: 3` against a cube-side implementation's `start: 6`. #770
// made the polygon the face, so `[{0,6,1},{6,30,0}]` became the CORRECT answer for that box —
// the instrument inverted rather than merely breaking. On a box every polygon is a quad, so a
// constant arity is right there and no box fixture can carry the class any more. A sphere can:
// its pole rows are triangles and its middle rows are quads.
//
// REF: src/app/materialGroups.ts (the mapping and why it is a step);
//      src/test-utils/twoMaterialMesh.ts (the fixtures); src/app/faceCount.ts (`faceArityOf`);
//      issues #638, #634, #633, #770.

import { BoxGeometry, SphereGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { faceArityOf, faceCountOf } from './faceCount';
import { coveredIndexCount, groupsFromMaterialIndex, groupsRefusal } from './materialGroups';
import {
  arrayGeometryRef,
  boxDescriptor,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { getForRead } from './geometryRegistry';
import { uniformMaterialAttributes } from '../nodes/meshAttributes';
import { MATERIAL_INDEX } from '../nodes/attributes';

/** A sphere's real arity at w=8 h=6: 16 pole triangles, 32 quads, 80 triangles, 240 entries. */
const SPHERE_ARITY = faceArityOf({
  kind: 'sphere',
  radius: 1,
  widthSegments: 8,
  heightSegments: 6,
})!;
/** A box's: six quads. The shape on which a constant and the truth cannot be told apart. */
const BOX_ARITY = faceArityOf(boxDescriptor([1, 1, 1]))!;
/** Every polygon a quad — the plausible wrong reading, at the sphere's polygon count. */
const CONSTANT_QUAD_ARITY = SPHERE_ARITY.map(() => 2);

describe('#638 the mapping is at polygon granularity (#770)', () => {
  it('lays out a MIXED-ARITY layout on the real arity, not on an assumed one', () => {
    // THE discriminating assertion of this step. Pole polygon 0 — a TRIANGLE — alone on slot 1.
    const indices = new Int32Array(48);
    indices[0] = 1;
    expect(groupsFromMaterialIndex(indices, 240, SPHERE_ARITY)).toEqual([
      { start: 0, count: 3, materialIndex: 1 },
      { start: 3, count: 237, materialIndex: 0 },
    ]);
    // Stated as its own expectation so the reason survives a future edit: an implementation
    // assuming every polygon is a quad yields [{0,6,1},{6,234,0}] here, which covers 240 of 240
    // and passes every coverage check. `start` is what discriminates.
    expect(groupsFromMaterialIndex(indices, 240, SPHERE_ARITY)?.[1].start).toBe(3);
    // And the wrong reading, run rather than described — a detector nobody has seen fire on the
    // answer it exists to reject reads as "no objection" forever. Fed the constant arity, the
    // same derivation produces exactly the layout above, with the same coverage.
    const wrong = groupsFromMaterialIndex(indices, 288, CONSTANT_QUAD_ARITY)!;
    expect(wrong[1].start, 'the wrong reading must be REACHABLE, or this row proves nothing').toBe(
      6,
    );
    expect(coveredIndexCount(wrong, 2), 'and must cover everything it is measured against').toBe(
      288,
    );
  });

  it('a BOX cannot carry that class, which is why the fixture had to move', () => {
    // Measured rather than asserted in prose. Every box polygon is a quad, so the real arity
    // and the constant are the SAME ARRAY — there is no wrong answer for a fixture to reject.
    expect(BOX_ARITY).toEqual([2, 2, 2, 2, 2, 2]);
    expect(BOX_ARITY).toEqual(BOX_ARITY.map(() => 2));
    const indices = new Int32Array(6);
    indices[0] = 1;
    // And `[{0,6,1},{6,30,0}]` — the layout the retired fixture was minted to REJECT — is now
    // the correct answer. That is the inversion, in one assertion.
    expect(groupsFromMaterialIndex(indices, 36, BOX_ARITY)).toEqual([
      { start: 0, count: 6, materialIndex: 1 },
      { start: 6, count: 30, materialIndex: 0 },
    ]);
  });

  it('lays out the 3/3 fixture — which a constant-arity implementation ALSO gets right', () => {
    const indices = new Int32Array(6);
    indices.fill(1, 3);
    expect(groupsFromMaterialIndex(indices, 36, BOX_ARITY)).toEqual([
      { start: 0, count: 18, materialIndex: 0 },
      { start: 18, count: 18, materialIndex: 1 },
    ]);
  });

  it('coalesces runs, so a slot change is a group and a repeat is not', () => {
    // Mixed arity inside the runs, so a coalescer that added face COUNTS rather than their
    // triangles would give the right group count and the wrong spans.
    const indices = Int32Array.from([0, 0, 1, 1, 1, 0]);
    const arity = [1, 2, 1, 2, 2, 1];
    expect(groupsFromMaterialIndex(indices, 27, arity)).toEqual([
      { start: 0, count: 9, materialIndex: 0 },
      { start: 9, count: 15, materialIndex: 1 },
      { start: 24, count: 3, materialIndex: 0 },
    ]);
  });

  it('keeps face order, never slot order', () => {
    // Sorting by slot would produce groups addressing triangles they do not cover.
    const indices = Int32Array.from([1, 0, 1]);
    expect(groupsFromMaterialIndex(indices, 9, [1, 1, 1])?.map((g) => g.materialIndex)).toEqual([
      1, 0, 1,
    ]);
  });

  it('gives a uniform assignment exactly one group', () => {
    expect(groupsFromMaterialIndex(new Int32Array(6), 36, BOX_ARITY)).toEqual([
      { start: 0, count: 36, materialIndex: 0 },
    ]);
  });
});

describe('#638 the derivation refuses by name rather than guessing', () => {
  it('refuses a NON-INDEXED geometry, naming the address space', () => {
    const why = groupsRefusal(new Int32Array(6), null, BOX_ARITY);
    expect(why).toContain('NOT INDEXED');
    expect(groupsFromMaterialIndex(new Int32Array(6), null, BOX_ARITY)).toBeNull();
  });

  it('refuses an index that describes a different mesh, naming both numbers', () => {
    const why = groupsRefusal(new Int32Array(6), 72, BOX_ARITY);
    expect(why).toContain('12 triangles');
    expect(why).toContain('72');
    expect(groupsFromMaterialIndex(new Int32Array(6), 72, BOX_ARITY)).toBeNull();
  });

  it('#770 — refuses an assignment that does not fit its LAYOUT, which is a third number', () => {
    // The state the old single comparison could not express, and the one a half-flipped
    // consumer produces: a twelve-entry `material_index` — the pre-#770 length — over a box
    // whose layout has six polygons. Its length still equals the old face count and it fits
    // NOTHING, so a derivation that only checked `length x 3 === indexCount` would have
    // accepted it against a 36-entry geometry and laid out groups over the wrong faces.
    const preFlip = new Int32Array(12);
    const why = groupsRefusal(preFlip, 36, BOX_ARITY);
    expect(why).toContain('12 faces');
    expect(why).toContain('6');
    expect(groupsFromMaterialIndex(preFlip, 36, BOX_ARITY)).toBeNull();
  });

  it('refuses an empty assignment', () => {
    expect(groupsRefusal(new Int32Array(0), 0, [])).toContain('empty');
  });
});

describe('#638 coverage, in the done-when clause 3 form, over all four sync-buildable kinds', () => {
  // Arm A of the clause (index === null) cannot arise here: all four of these build indexed.
  const kinds = [
    ['box', boxGeometryRef([1, 1, 1], null)],
    ['sphere', sphereGeometryRef(1, 8, 4, null)],
    ['array', arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 2, [2, 0, 0])],
    ['mirror', mirrorGeometryRef(boxGeometryRef([1, 1, 1], null), 'x', 0)],
  ] as const;

  for (const [name, ref] of kinds) {
    it(`${name}: a uniform layout covers every index element`, () => {
      const built = getForRead(ref);
      expect(built).not.toBeNull();
      const indexCount = built?.index?.count ?? null;
      expect(indexCount).not.toBeNull();

      const faces = faceCountOf(ref.descriptor);
      expect(faces).not.toBeNull();
      const arity = faceArityOf(ref.descriptor);
      expect(arity).not.toBeNull();
      // The relation the whole mapping rests on, asserted against the BUILT geometry.
      // ⚠️ IT IS `sum(arity) x 3` SINCE #770, NOT `faces x 3` — a face is a polygon, so the
      // multiplication that used to state this relation is the thing the phase removed.
      expect(arity!.length).toBe(faces);
      expect(indexCount).toBe(arity!.reduce((a, b) => a + b, 0) * 3);

      const groups = groupsFromMaterialIndex(new Int32Array(faces as number), indexCount, arity!);
      expect(groups).not.toBeNull();
      expect(coveredIndexCount(groups as [], 1)).toBe(indexCount);
    });
  }

  it('does NOT count a group whose slot has no material behind it', () => {
    // The qualifier that makes the clause discriminate. Without it, a stock box's six
    // built-in groups sum to 36 against index.count 36 and the naive equality passes on
    // exactly the failure it exists to catch.
    const indices = new Int32Array(6);
    indices.fill(1, 3);
    const groups = groupsFromMaterialIndex(indices, 36, BOX_ARITY) as [];
    expect(coveredIndexCount(groups, 2)).toBe(36);
    expect(coveredIndexCount(groups, 1)).toBe(18); // slot 1 unresolved -> not counted
  });
});

describe('#638 pinned facts — measurements in the repo, not folklore in a plan', () => {
  it('a stock BoxGeometry has six groups and a stock SphereGeometry has none', () => {
    // §2.1. This is why `build()` must clear groups unconditionally rather than only when
    // it has some to write: a box arrives with six the renderer would otherwise honour.
    expect(new BoxGeometry(1, 1, 1).groups.length).toBe(6);
    expect(new SphereGeometry(1, 8, 4).groups.length).toBe(0);
  });

  it('the minted mesh attribute set has exactly ONE member', () => {
    // The fold puts the WHOLE attribute set into geometry identity, so growth in this set
    // silently widens what a geometry key distinguishes. A second member is a decision, and
    // this reds when one arrives.
    const minted = uniformMaterialAttributes(boxDescriptor([1, 1, 1]));
    expect(minted).not.toBeNull();
    expect(Object.keys(minted?.set ?? {})).toEqual([MATERIAL_INDEX]);
  });
});
