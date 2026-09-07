// pathHeadings — #897. The facing a walked path implies.
//
// Every row here is about a case the live server measurement showed matters:
// the +X path hid the defect for months because facing +X IS the canonical
// heading, so the rows deliberately use paths that are NOT along +X.

import { describe, expect, it } from 'vitest';
import { tangentHeadings, type GroundVec } from './pathHeadings';

const p = (x: number, z: number): GroundVec => ({ x, z });
/** Angle in the ground plane, degrees, so a failure reads as a direction. */
const deg = (h: GroundVec): number => (Math.atan2(h.z, h.x) * 180) / Math.PI;

describe('tangentHeadings', () => {
  it('faces along a straight path, one heading per waypoint', () => {
    const out = tangentHeadings([p(0, 0), p(1, 0), p(2, 0)]);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(3);
    for (const h of out!) expect(deg(h)).toBeCloseTo(0, 6);
  });

  // THE CASE THE DEFECT LIVED IN. A +Z path must produce +Z facings; if the
  // components were swapped this row reads 0° and the character strafes.
  it('faces +Z on a +Z path — the axis mapping, not just the magnitude', () => {
    const out = tangentHeadings([p(0, 0), p(0, 1), p(0, 2)])!;
    for (const h of out) expect(deg(h)).toBeCloseTo(90, 6);
  });

  it('turns through a corner rather than averaging across it', () => {
    // Straight along +X, then a right-angle turn into +Z.
    const out = tangentHeadings([p(0, 0), p(1, 0), p(1, 1)])!;
    expect(deg(out[0])).toBeCloseTo(0, 6);
    expect(deg(out[1])).toBeCloseTo(90, 6);
    // The last waypoint keeps the facing it arrived with.
    expect(deg(out[2])).toBeCloseTo(90, 6);
  });

  it('returns unit vectors, so spacing never leaks into the facing', () => {
    // Wildly uneven spacing: a heading that carried magnitude would differ.
    const out = tangentHeadings([p(0, 0), p(0.001, 0), p(50, 0)])!;
    for (const h of out) expect(Math.hypot(h.x, h.z)).toBeCloseTo(1, 9);
  });

  it('carries the facing through a stationary stretch instead of spinning', () => {
    const out = tangentHeadings([p(0, 0), p(0, 1), p(0, 1), p(0, 2)])!;
    // The repeated point has no direction of its own; it keeps +Z.
    for (const h of out) expect(deg(h)).toBeCloseTo(90, 6);
  });

  it('fills a LEADING stationary stretch from the first real segment', () => {
    // Nothing to carry forward from at the start — facing must come backwards
    // from the first real move, not be left as a zero vector the server would
    // take as a heading.
    const out = tangentHeadings([p(0, 0), p(0, 0), p(-1, 0)])!;
    for (const h of out) {
      expect(Math.hypot(h.x, h.z)).toBeCloseTo(1, 9);
      expect(Math.abs(deg(h))).toBeCloseTo(180, 6);
    }
  });

  // ── THE REFUSALS. A heading invented for a path that expresses none is worse
  //    than none: the server honours whatever it is given. ────────────────────
  it('refuses a path that never moves', () => {
    expect(tangentHeadings([p(2, 3), p(2, 3), p(2, 3)])).toBeNull();
  });

  it('refuses a path too short to have a direction', () => {
    expect(tangentHeadings([p(1, 1)])).toBeNull();
    expect(tangentHeadings([])).toBeNull();
  });

  it('never emits a non-finite component', () => {
    // A segment below the movement threshold used to normalise to NaN, which the
    // server would accept and the model would honour as garbage.
    const out = tangentHeadings([p(0, 0), p(1e-12, 0), p(0, 5)])!;
    for (const h of out) {
      expect(Number.isFinite(h.x)).toBe(true);
      expect(Number.isFinite(h.z)).toBe(true);
    }
  });
});
