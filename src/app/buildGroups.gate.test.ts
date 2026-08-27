// #638 (ns-1b step 4) — the registry writes the group layout, and it is the only thing that
// may.
//
// ── THE TWO PROPERTIES, AND WHY NEITHER IS OBSERVABLE WITHOUT THE OTHER ───────────────
//
//   1. A built instance carries the layout its ref's per-face index describes — at TRIANGLE
//      granularity, and covering the whole index.
//   2. NOTHING ELSE in the repo calls `addGroup` or `clearGroups`. Groups live on the shared
//      instance, so a second writer is a per-object write to a shared resource: the defect
//      #530/#533 already cost this repo once, and the one a correct layout would hide.
//
// ⚠️ THE CENSUS STRIPS COMMENTS, AND THAT IS NOT A DETAIL. `materialGroups.ts` explains the
// mapping in prose that says `addGroup(3a, 3(b − a), s)` — so a census over raw text reports
// this property satisfied by a MODULE THAT NEVER CALLS IT, and would have reported it
// satisfied before step 4 was written. A gate that passes before its work is not a detector.
// Measured on the pre-step-4 tree: raw text `found = 1`, comment-stripped `found = 0`.
//
// REF: src/app/geometryRegistry.ts (`build` — the writer); src/app/materialGroups.ts (the
//      derivation); src/app/faceCount.ts (the refusal); src/test-utils/twoMaterialMesh.ts
//      (both fixtures); issues #638, #634, #530, #533.

import { beforeEach, describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';
import {
  boxDescriptor,
  boxGeometryRef,
  sphereDescriptor,
  sphereGeometryRef,
} from './modifierGeometry';
import { clear, getForRead } from './geometryRegistry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import {
  growthBySource as attributeGrowthBySource,
  resetGrowth as resetAttributeGrowth,
} from './attributeStore';
import { mixedArityMaterialMeshData, twoMaterialMeshData } from '../test-utils/twoMaterialMesh';

// `materialIndex` is OPTIONAL, because that is how three.js declares it on a live
// `BufferGeometry.groups` — and this helper is asked about built instances, not only about
// the derivation's own output. Requiring it here types the helper against a shape the
// subject does not have, which is the same mistake the coverage predicate exists to avoid.
const layoutOf = (geometry: {
  groups: { start: number; count: number; materialIndex?: number }[];
}) => geometry.groups.map((g) => [g.start, g.count, g.materialIndex]);

beforeEach(() => {
  clear();
});

describe('#638 build() writes the group layout from the ref’s per-face index', () => {
  it('a two-material box splits at the POLYGON boundary, covering the whole index', () => {
    const built = getForRead(twoMaterialMeshData().geometry)!;
    expect(built).not.toBeNull();
    expect(layoutOf(built)).toEqual([
      [0, 18, 0],
      [18, 18, 1],
    ]);
    // 3 faces × 2 triangles × 3 index entries = 18 per run, 36 in total — the geometry's whole
    // index. ⚠️ IT READ `6 faces × 3` UNTIL #770 AND THE PRODUCT IS UNCHANGED, which is exactly
    // why a box cannot be the discriminator: the two arithmetics land on the same number here.
    expect(built.getIndex()!.count).toBe(36);
  });

  it('the MIXED-ARITY case splits at start 3, not at start 6 — the granularity that can be wrong', () => {
    // 🔴 THIS ROW USED TO BE A BOX AND COULD NOT STAY ONE. It asserted the same boundary against
    // a cube-side implementation's `[[0,6,1],[6,30,0]]` — and #770 makes that layout CORRECT for
    // a box, since a box's polygons are its cube sides. The instrument inverted, so it moved to
    // the shape that still carries the class: a sphere, whose pole rows are triangles.
    //
    // An implementation assuming every polygon is a quad yields [[0,6,1],[6,234,0]] here, which
    // still covers 240 of 240 and looks right in pixels and in draw-call count. The BOUNDARY is
    // what discriminates — the same sentence, and the same number, one granularity along.
    const built = getForRead(mixedArityMaterialMeshData().geometry)!;
    expect(layoutOf(built)).toEqual([
      [0, 3, 1],
      [3, 237, 0],
    ]);
    expect(built.getIndex()!.count).toBe(240);
  });

  it('a uniform sphere gets exactly ONE group covering everything', () => {
    // Run coalescing, checked where it matters: a group per triangle would be 960 draw calls
    // for a mesh that needs one.
    const descriptor = sphereDescriptor(1, 32, 16);
    const built = getForRead(
      sphereGeometryRef(1, 32, 16, mintMeshAttributes(descriptor, 'evaluate')),
    )!;
    expect(built.groups).toHaveLength(1);
    expect(layoutOf(built)).toEqual([[0, 2880, 0]]);
    expect(built.getIndex()!.count).toBe(2880);
  });

  it('an UNATTRIBUTED box has NO groups — the stock six are gone', () => {
    // three.js gives every BoxGeometry six groups, one per cube side, and honours them
    // whether or not anything meant them as material slots. Under a two-length material
    // array that layout draws twelve of thirty-six triangles: quiet, plausible, and visible
    // only in pixels. `clearGroups()` runs unconditionally so the state cannot exist.
    const built = getForRead(boxGeometryRef([1, 1, 1], null))!;
    expect(built.groups).toHaveLength(0);
  });

  it('a uniform box is ONE group, so an unattributed box and an attributed one differ by intent', () => {
    const built = getForRead(
      boxGeometryRef([1, 1, 1], mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate')),
    )!;
    expect(layoutOf(built)).toEqual([[0, 36, 0]]);
  });

  it('two refs with the same key still resolve to ONE instance, layout included', () => {
    // The sharing the cache exists for, asserted by identity rather than by value — a clone
    // per object would pass every layout assertion above and fail this one.
    const value = twoMaterialMeshData();
    expect(getForRead(value.geometry)).toBe(getForRead(twoMaterialMeshData().geometry));
  });
});

describe('#638 nothing else in the repo writes groups', () => {
  it('addGroup / clearGroups appear in exactly ONE production file', () => {
    const files = sourceFiles();
    const found = files
      .filter(([, source]) => /\b(addGroup|clearGroups)\s*\(/.test(stripComments(source)))
      .map(([path]) => path);

    // examined is reported beside found, so a walk that stopped descending cannot report a
    // clean closed set over a smaller repo.
    expect({ examined: files.length, found }).toEqual({
      examined: files.length,
      found: ['src/app/geometryRegistry.ts'],
    });
    expect(files.length).toBeGreaterThan(500);
  });
});

describe('#638 step 4 growth — the number, and why it is NOT evidence', () => {
  it('adds ZERO attribute-store entries for the population that exists, as expected', () => {
    // 🔴 READ THIS AS THE EXPECTED FINDING, NOT AS A PASS. The uniform key is a function of
    // the face count alone, and the face count is already a function of the descriptor — so
    // for every producer that exists today the fold introduces no set that was not already
    // there. A zero delta here is indistinguishable from the fold never having been applied,
    // which is exactly the degenerate-population reading this epic has paid for three times.
    //
    // The measurement that CAN discriminate is the one taken when a per-face assignment
    // varies with a dragged param, and it belongs to the step that first authors one.
    mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate');
    resetAttributeGrowth();

    for (const size of [
      [1, 1, 1],
      [2, 2, 2],
      [3, 3, 3],
    ] as const) {
      getForRead(
        boxGeometryRef([...size], mintMeshAttributes(boxDescriptor([...size]), 'evaluate')),
      );
    }

    // Three distinct GEOMETRIES, three distinct cache entries — and ONE attribute set among
    // them, already resident, so growth is zero.
    expect(attributeGrowthBySource().evaluate).toBe(0);
  });
});
