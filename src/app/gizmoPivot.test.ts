import { describe, expect, it } from 'vitest';
import { pivotPoint } from './gizmoPivot';

type Vec3 = [number, number, number];
const A: Vec3 = [0, 0, 0];
const B: Vec3 = [4, 0, 0];
const C: Vec3 = [2, 6, 0];

describe('pivotPoint (#228 Blender pivot modes)', () => {
  it('median = average of origins', () => {
    expect(pivotPoint('median', [A, B, C], A)).toEqual([2, 2, 0]);
  });

  it('boundingBox = centre of the origins AABB (not the average)', () => {
    // AABB of A/B/C: x[0..4] y[0..6] z[0] → centre [2,3,0]; median is [2,2,0].
    expect(pivotPoint('boundingBox', [A, B, C], A)).toEqual([2, 3, 0]);
  });

  it('active = the active origin', () => {
    expect(pivotPoint('active', [A, B, C], C)).toEqual([2, 6, 0]);
  });

  it('active falls back to median when no active origin given', () => {
    expect(pivotPoint('active', [A, B], null)).toEqual([2, 0, 0]);
  });

  it('individual + cursor fall back to the median for the seed display', () => {
    expect(pivotPoint('individual', [A, B], A)).toEqual([2, 0, 0]);
    expect(pivotPoint('cursor', [A, B], A)).toEqual([2, 0, 0]);
  });

  it('empty selection → origin', () => {
    expect(pivotPoint('median', [], null)).toEqual([0, 0, 0]);
  });
});
