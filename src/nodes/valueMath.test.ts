// #292 (Epic 1 Inc 1) — the shared value-math core. These pin the primitive
// contracts the compute nodes rely on (and the byte-identical noise the F-Modifier
// stack shares). channelModifiers.test.ts separately proves the F-mod path is
// unchanged after the noise core moved here.

import { describe, expect, it } from 'vitest';
import { applyMathOp, clamp, curveRemap, fit, fractalNoise, lerp } from './valueMath';

describe('clamp', () => {
  it('passes values inside the range and bounds the rest', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-3, 0, 1)).toBe(0);
    expect(clamp(9, 0, 1)).toBe(1);
  });
  it('never exceeds max even with inverted bounds', () => {
    expect(clamp(5, 1, 0)).toBe(0);
  });
});

describe('lerp (mix)', () => {
  it('hits the endpoints and the midpoint', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.5)).toBe(15);
  });
  it('does not clamp t (extrapolates)', () => {
    expect(lerp(0, 10, 2)).toBe(20);
  });
});

describe('fit', () => {
  it('maps an input range onto an output range', () => {
    expect(fit(5, 0, 10, 0, 100)).toBe(50);
    expect(fit(0, 0, 10, 20, 40)).toBe(20);
  });
  it('a degenerate input range maps to outMin (no divide-by-zero)', () => {
    expect(fit(7, 3, 3, 1, 9)).toBe(1);
  });
  it('optionally clamps the normalised position before remapping', () => {
    expect(fit(20, 0, 10, 0, 100, false)).toBe(200);
    expect(fit(20, 0, 10, 0, 100, true)).toBe(100);
    expect(fit(-5, 0, 10, 0, 100, true)).toBe(0);
  });
});

describe('curveRemap', () => {
  const ramp = [
    { x: 0, y: 0 },
    { x: 1, y: 10 },
  ];
  it('linearly interpolates between control points', () => {
    expect(curveRemap(0.5, ramp)).toBe(5);
  });
  it('holds the first/last y outside the point range', () => {
    expect(curveRemap(-2, ramp)).toBe(0);
    expect(curveRemap(9, ramp)).toBe(10);
  });
  it('sorts unsorted points by x', () => {
    const unsorted = [
      { x: 1, y: 10 },
      { x: 0, y: 0 },
    ];
    expect(curveRemap(0.5, unsorted)).toBe(5);
  });
  it('is identity with no points', () => {
    expect(curveRemap(3.3, [])).toBe(3.3);
  });
});

describe('applyMathOp', () => {
  it('computes each arithmetic op', () => {
    expect(applyMathOp('add', 2, 3)).toBe(5);
    expect(applyMathOp('sub', 2, 3)).toBe(-1);
    expect(applyMathOp('mul', 2, 3)).toBe(6);
    expect(applyMathOp('div', 6, 3)).toBe(2);
  });
  it('divide-by-zero is safe (→ 0, not Infinity/NaN)', () => {
    expect(applyMathOp('div', 5, 0)).toBe(0);
  });
});

describe('fractalNoise (shared core — determinism + bounds)', () => {
  it('is deterministic in (x, depth)', () => {
    expect(fractalNoise(3.14, 2)).toBe(fractalNoise(3.14, 2));
  });
  it('stays within ≈[-1,1]', () => {
    for (let i = 0; i < 200; i++) {
      const v = fractalNoise(i * 0.37, 3);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
