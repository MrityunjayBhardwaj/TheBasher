// wheelZoom — the dolly one wheel event asks for, sized by how far the wheel moved (#1128).

import { describe, expect, it } from 'vitest';
import { wheelDolly } from './wheelZoom';

const px = (deltaY: number, ctrlKey = false) => ({ deltaY, deltaMode: 0, ctrlKey });

describe('wheelDolly', () => {
  it('keeps a mouse notch (deltaY 100) at exactly the old fixed step', () => {
    expect(wheelDolly(px(-100), 1, false)).toEqual({ direction: 'in', scale: 0.95 });
    expect(wheelDolly(px(100), 1, false)).toEqual({ direction: 'out', scale: 0.95 });
  });

  it('makes a trackpad-sized event a proportionally small step, not a full notch', () => {
    const { direction, scale } = wheelDolly(px(-4), 1, false);
    expect(direction).toBe('in');
    expect(scale).toBeCloseTo(Math.pow(0.95, 0.04), 12);
    // Twenty-five 4-px events travel as far as one 100-px notch.
    expect(Math.pow(scale, 25)).toBeCloseTo(0.95, 12);
  });

  it('converts line and page wheel modes to pixels before sizing the step', () => {
    expect(wheelDolly({ deltaY: -3, deltaMode: 1, ctrlKey: false }, 1, false).scale).toBeCloseTo(
      Math.pow(0.95, 0.48),
      12,
    );
    expect(wheelDolly({ deltaY: 1, deltaMode: 2, ctrlKey: false }, 1, false).scale).toBeCloseTo(
      0.95,
      12,
    );
  });

  it('amplifies a pinch (ctrlKey with no Control key down), and not a held Control key', () => {
    expect(wheelDolly(px(-2, true), 1, false).scale).toBeCloseTo(Math.pow(0.95, 0.2), 12);
    expect(wheelDolly(px(-2, true), 1, true).scale).toBeCloseTo(Math.pow(0.95, 0.02), 12);
  });

  it('scales with zoomSpeed', () => {
    expect(wheelDolly(px(-100), 2, false).scale).toBeCloseTo(0.9025, 12);
  });

  it('asks for no movement on a zero or non-finite delta', () => {
    expect(wheelDolly(px(0), 1, false)).toEqual({ direction: null, scale: 1 });
    expect(wheelDolly(px(Number.NaN), 1, false)).toEqual({ direction: null, scale: 1 });
  });
});
