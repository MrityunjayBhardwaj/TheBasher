// resolveStudioLightTransform — the Light-Studio panel's pure placement mapping
// (epic #201 / #206, §7.3). The SAME resolver feeds the panel puck + the
// authored light position (V37 parity), so round-trip exactness is the gate.

import { describe, expect, it } from 'vitest';
import {
  resolveStudioLightTransform,
  studioLightPanelXY,
} from './resolveStudioLightTransform';

type Vec3 = [number, number, number];
const ORIGIN: Vec3 = [0, 0, 0];

describe('resolveStudioLightTransform', () => {
  it('panel centre (0.5, 0.5) → on the +Z equator at the given radius', () => {
    const { position } = resolveStudioLightTransform([0.5, 0.5], 5, ORIGIN);
    expect(position[0]).toBeCloseTo(0, 6);
    expect(position[1]).toBeCloseTo(0, 6);
    expect(position[2]).toBeCloseTo(5, 6);
  });

  it('top of the panel (v=1) → the +Y pole regardless of azimuth', () => {
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const { position } = resolveStudioLightTransform([u, 1], 3, ORIGIN);
      expect(position[0]).toBeCloseTo(0, 6);
      expect(position[1]).toBeCloseTo(3, 6);
      expect(position[2]).toBeCloseTo(0, 6);
    }
  });

  it('bottom of the panel (v=0) → the -Y pole', () => {
    const { position } = resolveStudioLightTransform([0.3, 0], 2, ORIGIN);
    expect(position[1]).toBeCloseTo(-2, 6);
  });

  it('quarter azimuth (u=0.75) on the equator → +X side', () => {
    const { position } = resolveStudioLightTransform([0.75, 0.5], 4, ORIGIN);
    expect(position[0]).toBeCloseTo(4, 6);
    expect(position[2]).toBeCloseTo(0, 6);
  });

  it('places relative to a non-origin target', () => {
    const target: Vec3 = [10, 2, -3];
    const { position } = resolveStudioLightTransform([0.5, 0.5], 5, target);
    expect(position[0]).toBeCloseTo(10, 6);
    expect(position[1]).toBeCloseTo(2, 6);
    expect(position[2]).toBeCloseTo(2, 6); // -3 + 5 on +Z
  });

  it('always lands on the sphere (|position − target| === radius)', () => {
    const target: Vec3 = [1, 2, 3];
    for (const u of [0.1, 0.4, 0.9]) {
      for (const v of [0.2, 0.5, 0.85]) {
        const { position } = resolveStudioLightTransform([u, v], 7, target);
        const r = Math.hypot(
          position[0] - target[0],
          position[1] - target[1],
          position[2] - target[2],
        );
        expect(r).toBeCloseTo(7, 6);
      }
    }
  });
});

describe('studioLightPanelXY (inverse)', () => {
  it('round-trips panelXY → position → panelXY off the seam', () => {
    const target: Vec3 = [2, -1, 4];
    for (const u of [0.2, 0.45, 0.6, 0.8]) {
      for (const v of [0.25, 0.5, 0.7]) {
        const { position } = resolveStudioLightTransform([u, v], 6, target);
        const back = studioLightPanelXY(position, target);
        expect(back.panelXY[0]).toBeCloseTo(u, 5);
        expect(back.panelXY[1]).toBeCloseTo(v, 5);
        expect(back.radius).toBeCloseTo(6, 5);
      }
    }
  });

  it('recovers the radius (distance from target)', () => {
    const back = studioLightPanelXY([0, 0, 10], ORIGIN);
    expect(back.radius).toBeCloseTo(10, 6);
    expect(back.panelXY[0]).toBeCloseTo(0.5, 6);
    expect(back.panelXY[1]).toBeCloseTo(0.5, 6);
  });

  it('a position at the target maps to panel centre (degenerate radius)', () => {
    const back = studioLightPanelXY([5, 5, 5], [5, 5, 5]);
    expect(back).toEqual({ panelXY: [0.5, 0.5], radius: 0 });
  });
});
