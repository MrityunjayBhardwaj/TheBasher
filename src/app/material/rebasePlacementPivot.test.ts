// #1123 — a placement moved from one pivot to another draws the same texture.
//
// three builds a texture's UV matrix with `Matrix3.setUvTransform(offset, repeat, rotation, center)`.
// The pivot only enters the translation column, so for every tiling and rotation there is exactly
// one offset that makes a centre-pivot placement draw what an origin-pivot one does. These rows
// compare the two matrices three itself builds, not a formula restated.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { UvPlacement } from '../../nodes/types';
import { CENTRE_PIVOT, ORIGIN_PIVOT, rebasePlacementPivot } from './uvPlacement';

function uvMatrix(p: UvPlacement, pivot: readonly [number, number]): number[] {
  return new THREE.Matrix3()
    .setUvTransform(
      p.offset[0],
      p.offset[1],
      p.tiling[0],
      p.tiling[1],
      p.rotation,
      pivot[0],
      pivot[1],
    )
    .toArray();
}

const CASES: [string, UvPlacement][] = [
  [
    'the fixture: tiling [2,3], offset [0.1,0.2]',
    { tiling: [2, 3], offset: [0.1, 0.2], rotation: 0 },
  ],
  ['rotation alone', { tiling: [1, 1], offset: [0, 0], rotation: Math.PI / 2 }],
  ['rotation on a stretched map', { tiling: [4, 0.5], offset: [0.5, -0.25], rotation: 0.25 }],
  ['a mirrored axis', { tiling: [-1, 2], offset: [1, 0], rotation: -1.1 }],
];

describe('#1123 rebasePlacementPivot', () => {
  it.each(CASES)('%s draws the same after moving origin → centre', (_, p) => {
    const moved = rebasePlacementPivot(p, ORIGIN_PIVOT, CENTRE_PIVOT);
    const want = uvMatrix(p, ORIGIN_PIVOT);
    const got = uvMatrix(moved, CENTRE_PIVOT);
    for (let i = 0; i < 9; i++) expect(got[i]).toBeCloseTo(want[i], 12);
    // Only the offset moves: tiling and rotation are the same numbers the file wrote.
    expect(moved.tiling).toEqual(p.tiling);
    expect(moved.rotation).toBe(p.rotation);
  });

  it('is its own inverse', () => {
    const p = CASES[2][1];
    const back = rebasePlacementPivot(
      rebasePlacementPivot(p, ORIGIN_PIVOT, CENTRE_PIVOT),
      CENTRE_PIVOT,
      ORIGIN_PIVOT,
    );
    expect(back.offset[0]).toBeCloseTo(p.offset[0], 12);
    expect(back.offset[1]).toBeCloseTo(p.offset[1], 12);
  });

  it('leaves an identity placement byte-identical, so an untransformed material keys as before', () => {
    const identity: UvPlacement = { tiling: [1, 1], offset: [0, 0], rotation: 0 };
    const moved = rebasePlacementPivot(identity, ORIGIN_PIVOT, CENTRE_PIVOT);
    expect(moved).toEqual(identity);
    expect(Object.is(moved.offset[0], 0)).toBe(true);
    expect(Object.is(moved.offset[1], 0)).toBe(true);
  });

  it('the positive control: the unmoved placement does NOT draw the same under the other pivot', () => {
    const p = CASES[0][1];
    expect(uvMatrix(p, CENTRE_PIVOT)).not.toEqual(uvMatrix(p, ORIGIN_PIVOT));
  });
});
