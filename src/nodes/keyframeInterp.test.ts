// keyframeInterp — the shared scalar/vec3 sampling core (UX-BACKLOG #11).
// Proves the two contracts: (1) RENDER PARITY — a keyframe with no handles
// samples bit-identically to the legacy linear-lerp / smoothstep; (2) BÉZIER —
// explicit handles bend the curve, and flat handles reproduce smoothstep EXACTLY.

import { describe, expect, it } from 'vitest';
import {
  sampleScalarKeyframes,
  sampleVec3Keyframes,
  type ScalarKey,
  type Vec3Key,
} from './keyframeInterp';

const smoothstep = (u: number) => u * u * (3 - 2 * u);

describe('sampleScalarKeyframes — render parity (no handles)', () => {
  it('clamps before the first and after the last keyframe', () => {
    const keys: ScalarKey[] = [
      { time: 1, value: 10, easing: 'linear' },
      { time: 3, value: 30, easing: 'linear' },
    ];
    expect(sampleScalarKeyframes(keys, 0)).toBe(10);
    expect(sampleScalarKeyframes(keys, 5)).toBe(30);
  });

  it('empty channel → 0', () => {
    expect(sampleScalarKeyframes([], 2)).toBe(0);
  });

  it('LINEAR segment lerps exactly as before', () => {
    const keys: ScalarKey[] = [
      { time: 0, value: 0, easing: 'linear' },
      { time: 2, value: 10, easing: 'linear' },
    ];
    // u = 0.25 → 2.5, u = 0.5 → 5
    expect(sampleScalarKeyframes(keys, 0.5)).toBeCloseTo(2.5, 12);
    expect(sampleScalarKeyframes(keys, 1)).toBeCloseTo(5, 12);
  });

  it("CUBIC segment uses the DESTINATION key's easing → smoothstep, identical to legacy", () => {
    // Legacy: easing is taken from the destination keyframe (b.easing).
    const keys: ScalarKey[] = [
      { time: 0, value: 0, easing: 'linear' },
      { time: 1, value: 100, easing: 'cubic' },
    ];
    for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(sampleScalarKeyframes(keys, u)).toBeCloseTo(100 * smoothstep(u), 9);
    }
  });
});

describe('sampleScalarKeyframes — cubic bézier (with handles)', () => {
  it('FLAT handles at ±span/3 reproduce smoothstep exactly (the parity proof)', () => {
    // span = 1, flat handles: out at (+1/3, 0), in at (-1/3, 0).
    const keys: ScalarKey[] = [
      { time: 0, value: 0, easing: 'linear', outHandle: { time: 1 / 3, value: 0 } },
      { time: 1, value: 100, easing: 'linear', inHandle: { time: -1 / 3, value: 0 } },
    ];
    for (const u of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(sampleScalarKeyframes(keys, u)).toBeCloseTo(100 * smoothstep(u), 6);
    }
  });

  it('an ASYMMETRIC out-handle bends the curve away from the linear/smoothstep value', () => {
    // A strong upward out-handle overshoots early — value at the midpoint should
    // be ABOVE the straight-line 50.
    const keys: ScalarKey[] = [
      { time: 0, value: 0, easing: 'linear', outHandle: { time: 1 / 3, value: 60 } },
      { time: 1, value: 100, easing: 'linear', inHandle: { time: -1 / 3, value: 0 } },
    ];
    const mid = sampleScalarKeyframes(keys, 0.5);
    expect(mid).toBeGreaterThan(50);
    // Endpoints stay pinned to the keyframe values.
    expect(sampleScalarKeyframes(keys, 0)).toBeCloseTo(0, 9);
    expect(sampleScalarKeyframes(keys, 1)).toBeCloseTo(100, 9);
  });

  it('solves x→s correctly for a non-uniform time handle (value tracks time, not param)', () => {
    // Handles pushed toward the start in time but flat in value → still monotone
    // increasing, endpoints pinned, strictly within [0,100].
    const keys: ScalarKey[] = [
      { time: 0, value: 0, easing: 'linear', outHandle: { time: 0.1, value: 0 } },
      { time: 1, value: 100, easing: 'linear', inHandle: { time: -0.1, value: 0 } },
    ];
    const a = sampleScalarKeyframes(keys, 0.25);
    const b = sampleScalarKeyframes(keys, 0.5);
    const c = sampleScalarKeyframes(keys, 0.75);
    expect(a).toBeGreaterThan(0);
    expect(c).toBeLessThan(100);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe('sampleVec3Keyframes', () => {
  it('parity: no-handle cubic vec3 → per-component smoothstep', () => {
    const keys: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 1, value: [10, 20, 30], easing: 'cubic' },
    ];
    const v = sampleVec3Keyframes(keys, 0.5);
    expect(v[0]).toBeCloseTo(10 * smoothstep(0.5), 9);
    expect(v[1]).toBeCloseTo(20 * smoothstep(0.5), 9);
    expect(v[2]).toBeCloseTo(30 * smoothstep(0.5), 9);
  });

  it('bézier: a shared TIME handle with per-component VALUE offsets bends each axis independently', () => {
    const keys: Vec3Key[] = [
      {
        time: 0,
        value: [0, 0, 0],
        easing: 'linear',
        outHandle: { time: 1 / 3, value: [60, 0, -60] },
      },
      {
        time: 1,
        value: [100, 100, 100],
        easing: 'linear',
        inHandle: { time: -1 / 3, value: [0, 0, 0] },
      },
    ];
    const v = sampleVec3Keyframes(keys, 0.5);
    // x bent up (overshoot), z bent down, y near the flat-handle baseline.
    expect(v[0]).toBeGreaterThan(v[1]);
    expect(v[2]).toBeLessThan(v[1]);
    // endpoints pinned on all axes
    expect(sampleVec3Keyframes(keys, 0)).toEqual([0, 0, 0]);
    expect(sampleVec3Keyframes(keys, 1)).toEqual([100, 100, 100]);
  });

  it('clamps and handles the empty channel', () => {
    expect(sampleVec3Keyframes([], 1)).toEqual([0, 0, 0]);
    const keys: Vec3Key[] = [{ time: 2, value: [1, 2, 3], easing: 'cubic' }];
    expect(sampleVec3Keyframes(keys, 0)).toEqual([1, 2, 3]);
    expect(sampleVec3Keyframes(keys, 9)).toEqual([1, 2, 3]);
  });
});
