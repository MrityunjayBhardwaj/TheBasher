import { describe, expect, it } from 'vitest';
import { originToGeometry } from './setOrigin';

type Vec3 = [number, number, number];
const ID = { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3, pivot: [0, 0, 0] as Vec3 };

// Geometry-fixity check: content_world = position + R·S·(c − pivot). With
// identity R/S this is position + c − pivot. The point that mattered (the
// content) must render at the same world spot before and after.
function contentWorld(p: { position: Vec3; pivot: Vec3 }, c: Vec3): Vec3 {
  return [c[0] - p.pivot[0] + p.position[0], c[1] - p.pivot[1] + p.position[1], c[2] - p.pivot[2] + p.position[2]];
}

describe('originToGeometry (#228 Set Origin to Geometry)', () => {
  it('moves the origin to the world centre (identity group)', () => {
    const out = originToGeometry(ID, [2, 0, 0]);
    expect(out.position).toEqual([2, 0, 0]);
    // pivot compensates by the same delta so geometry stays put.
    expect(out.pivot[0]).toBeCloseTo(2);
  });

  it('keeps the geometry fixed (identity): content renders unchanged', () => {
    const c: Vec3 = [3, 1, -1];
    const before = contentWorld(ID, c); // [3,1,-1]
    const out = originToGeometry(ID, [2, 0, 0]);
    const after = contentWorld({ position: out.position, pivot: out.pivot }, c);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
    expect(after[2]).toBeCloseTo(before[2]);
  });

  it('accounts for scale in the pivot compensation', () => {
    // scale 2 → a world delta of 4 is a local delta of 2.
    const out = originToGeometry({ ...ID, scale: [2, 2, 2], position: [0, 0, 0] }, [4, 0, 0]);
    expect(out.position).toEqual([4, 0, 0]);
    expect(out.pivot[0]).toBeCloseTo(2); // (R·S)⁻¹·4 = 2
  });

  it('accounts for a starting pivot/position offset', () => {
    const out = originToGeometry({ ...ID, position: [1, 0, 0], pivot: [0.5, 0, 0] }, [5, 0, 0]);
    expect(out.position).toEqual([5, 0, 0]);
    // newPivot = oldPivot + (worldCentre − oldPos) = 0.5 + (5 − 1) = 4.5
    expect(out.pivot[0]).toBeCloseTo(4.5);
  });
});
