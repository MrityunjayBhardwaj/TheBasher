// keyframeInterp — the shared scalar/vec3 sampling core (UX-BACKLOG #11).
// Proves the two contracts: (1) RENDER PARITY — a keyframe with no handles
// samples bit-identically to the legacy linear-lerp / smoothstep; (2) BÉZIER —
// explicit handles bend the curve, and flat handles reproduce smoothstep EXACTLY.

import { describe, expect, it } from 'vitest';
import {
  sampleScalarKeyframes,
  sampleScalarKeyframesExtended,
  sampleVec3Keyframes,
  sampleVec3KeyframesExtended,
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

describe('D1 extend / extrapolation (#269, V88 D1)', () => {
  // Linear 0@t0 → 10@t2. In-range value(t) = 5t. Domain [0,2], span 2.
  const keys: ScalarKey[] = [
    { time: 0, value: 0, easing: 'linear' },
    { time: 2, value: 10, easing: 'linear' },
  ];

  it('DEFAULT (no rule) === hold === the pre-#269 clamp, byte-identical', () => {
    // In-range unchanged; out-of-range holds the boundary value on BOTH sides —
    // exactly what sampleScalarKeyframes did before the extend rules existed.
    for (const t of [-3, -1, 0, 0.5, 1, 2, 4, 9]) {
      expect(sampleScalarKeyframesExtended(keys, t)).toBeCloseTo(
        sampleScalarKeyframes(keys, t),
        12,
      );
    }
    // explicit hold matches the default
    expect(sampleScalarKeyframesExtended(keys, 4, 'hold', 'hold')).toBe(10);
    expect(sampleScalarKeyframesExtended(keys, -1, 'hold', 'hold')).toBe(0);
  });

  it('cycle repeats the range verbatim (teleports at the seam)', () => {
    // after: t=3 → maps to t=1 → 5; t=4 → maps to t=0 → 0 (the teleport).
    expect(sampleScalarKeyframesExtended(keys, 3, 'hold', 'cycle')).toBeCloseTo(5, 9);
    expect(sampleScalarKeyframesExtended(keys, 4, 'hold', 'cycle')).toBeCloseTo(0, 9);
    // before: t=-1 → maps to t=1 → 5.
    expect(sampleScalarKeyframesExtended(keys, -1, 'cycle', 'hold')).toBeCloseTo(5, 9);
  });

  it('cycle-offset travels seamlessly (accumulates the endpoint delta per period)', () => {
    // after: t=3 → 5 + 1·(10-0) = 15; t=4 → 0 + 2·10 = 20. No teleport — the value
    // keeps climbing (the seamless-loop headline vs plain cycle's teleport).
    expect(sampleScalarKeyframesExtended(keys, 3, 'hold', 'cycle-offset')).toBeCloseTo(15, 9);
    expect(sampleScalarKeyframesExtended(keys, 4, 'hold', 'cycle-offset')).toBeCloseTo(20, 9);
    // before: t=-1 → 5 + (-1)·10 = -5 (travels the other way).
    expect(sampleScalarKeyframesExtended(keys, -1, 'cycle-offset', 'hold')).toBeCloseTo(-5, 9);
    // continuity at the seam: just past t=2 the value is endpoint + 5·ε ≈ 10.0005,
    // i.e. continuous from the endpoint (10) — no jump (the seamless property).
    expect(sampleScalarKeyframesExtended(keys, 2.0001, 'hold', 'cycle-offset')).toBeCloseTo(10, 2);
  });

  it('mirror ping-pongs (reflects the range each period, no travel)', () => {
    // after: t=2.5 → reflect to t=1.5 → 7.5; t=3 → t=1 → 5; t=4 → t=0 → 0.
    expect(sampleScalarKeyframesExtended(keys, 2.5, 'hold', 'mirror')).toBeCloseTo(7.5, 9);
    expect(sampleScalarKeyframesExtended(keys, 3, 'hold', 'mirror')).toBeCloseTo(5, 9);
    expect(sampleScalarKeyframesExtended(keys, 4, 'hold', 'mirror')).toBeCloseTo(0, 9);
  });

  it('slope extrapolates linearly along the boundary tangent', () => {
    // tangent = (10-0)/(2-0) = 5. after: t=3 → 10 + 5·1 = 15; t=5 → 10 + 5·3 = 25.
    expect(sampleScalarKeyframesExtended(keys, 3, 'hold', 'slope')).toBeCloseTo(15, 9);
    expect(sampleScalarKeyframesExtended(keys, 5, 'hold', 'slope')).toBeCloseTo(25, 9);
    // before: t=-1 → 0 + 5·(-1) = -5.
    expect(sampleScalarKeyframesExtended(keys, -1, 'slope', 'hold')).toBeCloseTo(-5, 9);
  });

  it('the two sides are INDEPENDENT (before=slope, after=cycle-offset)', () => {
    expect(sampleScalarKeyframesExtended(keys, -1, 'slope', 'cycle-offset')).toBeCloseTo(-5, 9);
    expect(sampleScalarKeyframesExtended(keys, 3, 'slope', 'cycle-offset')).toBeCloseTo(15, 9);
  });

  it('degenerate domain (single key / zero span) collapses every rule to hold', () => {
    const one: ScalarKey[] = [{ time: 1, value: 7, easing: 'linear' }];
    for (const rule of ['cycle', 'cycle-offset', 'mirror', 'slope'] as const) {
      expect(sampleScalarKeyframesExtended(one, -5, rule, rule)).toBe(7);
      expect(sampleScalarKeyframesExtended(one, 99, rule, rule)).toBe(7);
    }
  });

  it('vec3 cycle-offset travels per-component (the walk-cycle-that-moves)', () => {
    // position [0,0,0]@0 → [2,0,0]@2. t=4 → maps to t=0 [0,0,0] + 2·[2,0,0] = [4,0,0].
    const pos: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 2, value: [2, 0, 0], easing: 'linear' },
    ];
    expect(sampleVec3KeyframesExtended(pos, 4, 'hold', 'cycle-offset')).toEqual([4, 0, 0]);
    expect(sampleVec3KeyframesExtended(pos, 3, 'hold', 'cycle-offset')[0]).toBeCloseTo(3, 9);
    // vec3 hold default matches the legacy clamp.
    expect(sampleVec3KeyframesExtended(pos, 9)).toEqual([2, 0, 0]);
  });
});
