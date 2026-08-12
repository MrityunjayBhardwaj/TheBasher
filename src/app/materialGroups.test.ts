// #638 (ns-1b step 2) — the face index becomes a group layout, at TRIANGLE granularity.
//
// The load-bearing assertion in this file is the group BOUNDARY on the non-aligned fixture,
// not coverage. A cube-side implementation covers 36 of 36 and is still wrong by 2x; only
// `start: 3` tells the two apart. Everything else here exists to stop that assertion being
// weakened later by someone who reads coverage as sufficient.
//
// REF: src/app/materialGroups.ts (the mapping and why it is a step);
//      src/test-utils/twoMaterialMesh.ts (both fixtures); src/app/faceCount.ts;
//      issues #638, #634, #633.

import { BoxGeometry, SphereGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { faceCountOf } from './faceCount';
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

describe('#638 the mapping is at triangle granularity', () => {
  it('lays out the NON-ALIGNED fixture on a triangle boundary, not a cube-side one', () => {
    // THE discriminating assertion of this step. Face 0 alone on slot 1.
    const indices = new Int32Array(12);
    indices[0] = 1;
    expect(groupsFromMaterialIndex(indices, 36)).toEqual([
      { start: 0, count: 3, materialIndex: 1 },
      { start: 3, count: 33, materialIndex: 0 },
    ]);
    // Stated as its own expectation so the reason survives a future edit: a cube-side
    // implementation yields [{0,6,1},{6,30,0}] here, which covers 36 of 36 and passes every
    // coverage check. `start` is what discriminates.
    expect(groupsFromMaterialIndex(indices, 36)?.[1].start).toBe(3);
  });

  it('lays out the 6/6 fixture — which a cube-side implementation ALSO gets right', () => {
    const indices = new Int32Array(12);
    indices.fill(1, 6);
    expect(groupsFromMaterialIndex(indices, 36)).toEqual([
      { start: 0, count: 18, materialIndex: 0 },
      { start: 18, count: 18, materialIndex: 1 },
    ]);
  });

  it('coalesces runs, so a slot change is a group and a repeat is not', () => {
    const indices = Int32Array.from([0, 0, 1, 1, 1, 0]);
    expect(groupsFromMaterialIndex(indices, 18)).toEqual([
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 9, materialIndex: 1 },
      { start: 15, count: 3, materialIndex: 0 },
    ]);
  });

  it('keeps face order, never slot order', () => {
    // Sorting by slot would produce groups addressing triangles they do not cover.
    const indices = Int32Array.from([1, 0, 1]);
    expect(groupsFromMaterialIndex(indices, 9)?.map((g) => g.materialIndex)).toEqual([1, 0, 1]);
  });

  it('gives a uniform assignment exactly one group', () => {
    expect(groupsFromMaterialIndex(new Int32Array(12), 36)).toEqual([
      { start: 0, count: 36, materialIndex: 0 },
    ]);
  });
});

describe('#638 the derivation refuses by name rather than guessing', () => {
  it('refuses a NON-INDEXED geometry, naming the address space', () => {
    const why = groupsRefusal(new Int32Array(12), null);
    expect(why).toContain('NOT INDEXED');
    expect(groupsFromMaterialIndex(new Int32Array(12), null)).toBeNull();
  });

  it('refuses an index that describes a different mesh, naming both numbers', () => {
    const why = groupsRefusal(new Int32Array(12), 72);
    expect(why).toContain('12');
    expect(why).toContain('72');
    expect(groupsFromMaterialIndex(new Int32Array(12), 72)).toBeNull();
  });

  it('refuses an empty assignment', () => {
    expect(groupsRefusal(new Int32Array(0), 0)).toContain('empty');
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
      // The relation the whole mapping rests on, asserted against the BUILT geometry.
      expect(indexCount).toBe((faces as number) * 3);

      const groups = groupsFromMaterialIndex(new Int32Array(faces as number), indexCount);
      expect(groups).not.toBeNull();
      expect(coveredIndexCount(groups as [], 1)).toBe(indexCount);
    });
  }

  it('does NOT count a group whose slot has no material behind it', () => {
    // The qualifier that makes the clause discriminate. Without it, a stock box's six
    // built-in groups sum to 36 against index.count 36 and the naive equality passes on
    // exactly the failure it exists to catch.
    const indices = new Int32Array(12);
    indices.fill(1, 6);
    const groups = groupsFromMaterialIndex(indices, 36) as [];
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
