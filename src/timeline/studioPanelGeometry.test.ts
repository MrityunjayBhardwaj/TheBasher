// studioPanelGeometry — the panel's screen↔panelXY mapping (#206). Asserts the
// v-flip (v=1 / +Y pole → top of canvas) and the clamped round-trip, so the e2e
// and the component share ONE geometry (H95).

import { describe, expect, it } from 'vitest';
import { panelXYToFraction, fractionToPanelXY } from './studioPanelGeometry';

describe('studioPanelGeometry', () => {
  it('maps u straight across and flips v (top = +Y pole)', () => {
    expect(panelXYToFraction([0.5, 1])).toEqual({ leftFrac: 0.5, topFrac: 0 }); // pole → top
    expect(panelXYToFraction([0.5, 0])).toEqual({ leftFrac: 0.5, topFrac: 1 }); // -Y → bottom
    expect(panelXYToFraction([0.5, 0.5])).toEqual({ leftFrac: 0.5, topFrac: 0.5 }); // equator
  });

  it('round-trips panelXY → fraction → panelXY', () => {
    for (const xy of [
      [0.2, 0.8],
      [0.5, 0.5],
      [0.9, 0.1],
    ] as const) {
      const { leftFrac, topFrac } = panelXYToFraction(xy);
      const [u, v] = fractionToPanelXY(leftFrac, topFrac);
      expect(u).toBeCloseTo(xy[0], 10);
      expect(v).toBeCloseTo(xy[1], 10);
    }
  });

  it('clamps a pointer that leaves the rect to the panel edge', () => {
    expect(fractionToPanelXY(-0.3, 1.4)).toEqual([0, 0]);
    expect(fractionToPanelXY(1.7, -0.2)).toEqual([1, 1]);
  });
});
