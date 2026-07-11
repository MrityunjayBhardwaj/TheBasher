// #292 (Epic 1 Inc 1) — the shared value-math core. These pin the primitive
// contracts the compute nodes rely on (and the byte-identical noise the F-Modifier
// stack shares). channelModifiers.test.ts separately proves the F-mod path is
// unchanged after the noise core moved here.

import { describe, expect, it } from 'vitest';
import {
  applyMathOp,
  applyVec3Op,
  clamp,
  curveRemap,
  fit,
  fractalNoise,
  lagStep,
  lerp,
  vec3Add,
  vec3Dot,
  vec3Length,
  vec3Mix,
  vec3Scale,
  vec3Sub,
} from './valueMath';
import type { Vec3 } from './types';

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

describe('lagStep (stateful first-order step)', () => {
  it('factor 1 snaps to the input (no lag)', () => {
    expect(lagStep(0, 10, 1)).toBe(10);
  });
  it('factor 0 holds the previous value (infinite lag)', () => {
    expect(lagStep(3, 10, 0)).toBe(3);
  });
  it('closes a fraction of the gap each step', () => {
    expect(lagStep(0, 10, 0.5)).toBe(5);
    expect(lagStep(5, 10, 0.5)).toBe(7.5);
  });
  it('clamps factor into [0,1] so it never overshoots or diverges', () => {
    expect(lagStep(0, 10, 2)).toBe(10); // >1 clamps to 1 → snaps, no overshoot
    expect(lagStep(3, 10, -1)).toBe(3); // <0 clamps to 0 → holds
  });
  it('is a pure function of (prev, input, factor) — same args, same result', () => {
    expect(lagStep(2, 9, 0.3)).toBe(lagStep(2, 9, 0.3));
  });
  it('converges toward a held input over repeated steps (settling)', () => {
    let v = 0;
    for (let i = 0; i < 50; i++) v = lagStep(v, 10, 0.3);
    expect(v).toBeGreaterThan(9.99);
    expect(v).toBeLessThanOrEqual(10);
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

describe('vector math (Vector3 rail)', () => {
  const a: Vec3 = [1, 2, 3];
  const b: Vec3 = [4, 5, 6];

  it('add / sub are component-wise', () => {
    expect(vec3Add(a, b)).toEqual([5, 7, 9]);
    expect(vec3Sub(b, a)).toEqual([3, 3, 3]);
  });

  it('scale multiplies every component', () => {
    expect(vec3Scale(a, 2)).toEqual([2, 4, 6]);
    expect(vec3Scale(a, 0)).toEqual([0, 0, 0]);
  });

  it('mix is component-wise lerp (unclamped, mirrors lerp)', () => {
    expect(vec3Mix(a, b, 0)).toEqual([1, 2, 3]);
    expect(vec3Mix(a, b, 1)).toEqual([4, 5, 6]);
    expect(vec3Mix(a, b, 0.5)).toEqual([2.5, 3.5, 4.5]);
  });

  it('dot and length are the standard scalar reductions', () => {
    expect(vec3Dot(a, b)).toBe(1 * 4 + 2 * 5 + 3 * 6); // 32
    expect(vec3Length([3, 4, 0])).toBe(5);
  });

  it('applyVec3Op dispatches the op (s is the scalar operand for scale/mix)', () => {
    expect(applyVec3Op('add', a, b, 99)).toEqual([5, 7, 9]); // s ignored
    expect(applyVec3Op('sub', b, a, 99)).toEqual([3, 3, 3]); // s ignored
    expect(applyVec3Op('scale', a, b, 3)).toEqual([3, 6, 9]); // b ignored
    expect(applyVec3Op('mix', a, b, 0.5)).toEqual([2.5, 3.5, 4.5]);
  });
});
