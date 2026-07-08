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
  sampleVec2KeyframesExtended,
  modifiersForAxis,
  resolveExtend,
  buildPerAxisExtend,
  type ScalarKey,
  type Vec2Key,
  type Vec3Key,
  type AxisExtend,
} from './keyframeInterp';
import type { FChannelModifier, FModCycles, FModNoise } from './channelModifiers';

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

  it('cycle COUNT (#270) freezes after N periods; 0 = infinite (byte-identical)', () => {
    // count 0 (default) = infinite — unchanged from the no-count signature.
    expect(sampleScalarKeyframesExtended(keys, 6, 'hold', 'cycle-offset', 0, 0)).toBeCloseTo(30, 9);
    // cycle-offset, cyclesAfter=1: the 1st repeat still plays (t=3 → 15), but past
    // 1 period it FREEZES at last + 1·delta = 20 (vs infinite's 30 at t=6).
    expect(sampleScalarKeyframesExtended(keys, 3, 'hold', 'cycle-offset', 0, 1)).toBeCloseTo(15, 9);
    expect(sampleScalarKeyframesExtended(keys, 6, 'hold', 'cycle-offset', 0, 1)).toBeCloseTo(20, 9);
    // continuity: the freeze value equals the value approached at the count boundary.
    expect(sampleScalarKeyframesExtended(keys, 4, 'hold', 'cycle-offset', 0, 1)).toBeCloseTo(20, 9);
    // plain cycle, cyclesAfter=2: past 2 periods holds the LAST key (10), no offset.
    expect(sampleScalarKeyframesExtended(keys, 7, 'hold', 'cycle', 0, 2)).toBeCloseTo(10, 9);
    // before side is independent: cycle-offset, cyclesBefore=1 → t=-3 freezes at
    // first − 1·delta = -10 (vs infinite's -15).
    expect(sampleScalarKeyframesExtended(keys, -3, 'cycle-offset', 'hold', 1, 0)).toBeCloseTo(
      -10,
      9,
    );
    // slope, cyclesAfter=1: linear for 1 span then holds → 10 + 5·(1·span=2) = 20
    // (vs infinite's 25 at t=5).
    expect(sampleScalarKeyframesExtended(keys, 5, 'hold', 'slope', 0, 1)).toBeCloseTo(20, 9);
    // mirror is continuous: cyclesAfter=1 freezes at the reflection at t=4 → 0.
    expect(sampleScalarKeyframesExtended(keys, 10, 'hold', 'mirror', 0, 1)).toBeCloseTo(0, 9);
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

describe('#272 — per-keyframe interpolation modes (Blender F-Curve interps)', () => {
  // Destination-key-governs: keys[1].easing describes how the curve ARRIVES at t=2.
  // Segment 0→10 over t∈[0,2], so value(t) = 10 · easeFraction(easing, ease, t/2).
  const seg = (easing: ScalarKey['easing'], ease?: ScalarKey['ease']): ScalarKey[] => [
    { time: 0, value: 0, easing: 'linear' },
    { time: 2, value: 10, easing, ease },
  ];

  it('constant holds the SOURCE value across the segment, snaps at the key', () => {
    const k = seg('constant');
    expect(sampleScalarKeyframes(k, 0)).toBe(0);
    expect(sampleScalarKeyframes(k, 1)).toBe(0); // held, not 5
    expect(sampleScalarKeyframes(k, 1.999)).toBe(0);
    expect(sampleScalarKeyframes(k, 2)).toBe(10); // snap at the destination key
  });

  it('every equation is exact at both endpoints (0 and V)', () => {
    for (const e of [
      'sine',
      'quad',
      'quart',
      'quint',
      'expo',
      'circ',
      'back',
      'bounce',
      'elastic',
    ] as const) {
      for (const d of ['in', 'out', 'inout'] as const) {
        const k = seg(e, d);
        expect(sampleScalarKeyframes(k, 0), `${e}-${d}@0`).toBeCloseTo(0, 9);
        expect(sampleScalarKeyframes(k, 2), `${e}-${d}@2`).toBeCloseTo(10, 9);
      }
    }
  });

  it('known midpoints match the Penner formulas', () => {
    // quad-in @u=0.5 → 0.25·10 = 2.5; quad-out → 0.75·10 = 7.5.
    expect(sampleScalarKeyframes(seg('quad', 'in'), 1)).toBeCloseTo(2.5, 9);
    expect(sampleScalarKeyframes(seg('quad', 'out'), 1)).toBeCloseTo(7.5, 9);
    // sine-inout @u=0.5 → 0.5·10 = 5 (symmetric).
    expect(sampleScalarKeyframes(seg('sine', 'inout'), 1)).toBeCloseTo(5, 9);
    // default ease is 'inout' when omitted → same as explicit inout.
    expect(sampleScalarKeyframes(seg('sine'), 1)).toBeCloseTo(5, 9);
    // quint-in @u=0.5 → 0.5^5·10 = 0.3125.
    expect(sampleScalarKeyframes(seg('quint', 'in'), 1)).toBeCloseTo(0.3125, 9);
  });

  it('back/elastic overshoot past the endpoints mid-segment (the flavour)', () => {
    // back-in dips BELOW 0 near the start (overshoot); back-out rises ABOVE 10.
    expect(sampleScalarKeyframes(seg('back', 'in'), 0.3)).toBeLessThan(0);
    expect(sampleScalarKeyframes(seg('back', 'out'), 1.7)).toBeGreaterThan(10);
  });

  it('equation interpolation applies the SAME eased fraction to every vec3 component', () => {
    const pos: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 2, value: [10, 20, -4], easing: 'quad', ease: 'in' },
    ];
    // u=0.5 → f=0.25 → [2.5, 5, -1].
    const v = sampleVec3Keyframes(pos, 1);
    expect(v[0]).toBeCloseTo(2.5, 9);
    expect(v[1]).toBeCloseTo(5, 9);
    expect(v[2]).toBeCloseTo(-1, 9);
  });
});

describe('#273 — per-keyframe handle types (Blender F-Curve handles)', () => {
  // Rise-then-hold (0→10→10): the classic case that separates auto (overshoots
  // above 10 on the hold segment) from auto-clamped (flattens at the peak → holds).
  const riseHold = (h: 'auto' | 'auto-clamped'): ScalarKey[] => [
    { time: 0, value: 0, easing: 'cubic', handleType: h },
    { time: 1, value: 10, easing: 'cubic', handleType: h },
    { time: 2, value: 10, easing: 'cubic', handleType: h },
  ];

  it('AUTO overshoots above the destination on a rise-then-hold', () => {
    expect(sampleScalarKeyframes(riseHold('auto'), 1.5)).toBeGreaterThan(10);
  });

  it('AUTO-CLAMPED does NOT overshoot — it flattens at the local extremum', () => {
    const v = sampleScalarKeyframes(riseHold('auto-clamped'), 1.5);
    expect(v).toBeCloseTo(10, 6); // flat handles on both sides → constant 10
    expect(v).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('VECTOR reduces to a straight line on a straight ramp', () => {
    const ramp: ScalarKey[] = [
      { time: 0, value: 0, easing: 'cubic', handleType: 'vector' },
      { time: 2, value: 10, easing: 'cubic', handleType: 'vector' },
    ];
    expect(sampleScalarKeyframes(ramp, 1)).toBeCloseTo(5, 6); // midpoint (bisection ~1e-9)
    expect(sampleScalarKeyframes(ramp, 0.5)).toBeCloseTo(2.5, 6);
  });

  it('FREE with an explicit handle == the same handle with no handleType (byte-parity)', () => {
    const withHandle = (ht?: 'free'): ScalarKey[] => [
      { time: 0, value: 0, easing: 'linear', handleType: ht, outHandle: { time: 0.5, value: 6 } },
      { time: 2, value: 10, easing: 'linear', handleType: ht },
    ];
    for (const t of [0.3, 0.7, 1.1, 1.6]) {
      expect(sampleScalarKeyframes(withHandle('free'), t)).toBeCloseTo(
        sampleScalarKeyframes(withHandle(undefined), t),
        9,
      );
    }
  });

  it('undefined handleType leaves the fast path untouched (no drift vs smoothstep)', () => {
    const keys: ScalarKey[] = [
      { time: 0, value: 0, easing: 'cubic' },
      { time: 2, value: 10, easing: 'cubic' },
    ];
    expect(sampleScalarKeyframes(keys, 1)).toBeCloseTo(10 * smoothstep(0.5), 12); // = 5
    expect(sampleScalarKeyframes(keys, 0.5)).toBeCloseTo(10 * smoothstep(0.25), 12);
  });

  it('equation interpolation still ignores handle type', () => {
    const keys: ScalarKey[] = [
      { time: 0, value: 0, easing: 'linear', handleType: 'auto' },
      { time: 2, value: 10, easing: 'quad', ease: 'in', handleType: 'auto' },
    ];
    // u=0.5 → quad-in f=0.25 → 2.5 (handle type must not perturb this).
    expect(sampleScalarKeyframes(keys, 1)).toBeCloseTo(2.5, 9);
  });

  it('vec3 samples handle types PER COMPONENT (X overshoots, Y/Z stay flat)', () => {
    const pos: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'cubic', handleType: 'auto' },
      { time: 1, value: [10, 0, 0], easing: 'cubic', handleType: 'auto' },
      { time: 2, value: [10, 0, 0], easing: 'cubic', handleType: 'auto' },
    ];
    const v = sampleVec3Keyframes(pos, 1.5);
    expect(v[0]).toBeGreaterThan(10); // X overshoots (auto)
    expect(v[1]).toBeCloseTo(0, 9); // Y flat
    expect(v[2]).toBeCloseTo(0, 9); // Z flat
  });

  it('auto-clamped vec3 rise-then-hold does NOT overshoot on X', () => {
    const pos: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'cubic', handleType: 'auto-clamped' },
      { time: 1, value: [10, 0, 0], easing: 'cubic', handleType: 'auto-clamped' },
      { time: 2, value: [10, 0, 0], easing: 'cubic', handleType: 'auto-clamped' },
    ];
    expect(sampleVec3Keyframes(pos, 1.5)[0]).toBeCloseTo(10, 6);
  });
});

describe('#275 — resolveExtend (stored extrapolation + Cycles modifier → engine rule)', () => {
  const cycles = (over: Partial<FModCycles>): FModCycles => ({
    type: 'cycles',
    beforeMode: 'none',
    afterMode: 'none',
    beforeCycles: 0,
    afterCycles: 0,
    ...over,
  });

  it('no modifier → the stored extrapolation passes through, counts 0', () => {
    expect(resolveExtend('slope', 'hold')).toEqual({
      before: 'slope',
      after: 'hold',
      cyclesBefore: 0,
      cyclesAfter: 0,
    });
  });

  it('a Cycles mode OVERRIDES that side, mapping to the internal rule + count', () => {
    const mods = [cycles({ afterMode: 'repeat-offset', afterCycles: 2 })];
    expect(resolveExtend('hold', 'hold', mods)).toEqual({
      before: 'hold',
      after: 'cycle-offset',
      cyclesBefore: 0,
      cyclesAfter: 2,
    });
    expect(resolveExtend('slope', 'slope', [cycles({ beforeMode: 'repeat-mirror' })])).toEqual({
      before: 'mirror',
      after: 'slope', // afterMode 'none' → stored 'slope' survives
      cyclesBefore: 0,
      cyclesAfter: 0,
    });
  });

  it("a 'none' side falls back to the stored extrapolation (no override)", () => {
    expect(resolveExtend('slope', 'slope', [cycles({})])).toEqual({
      before: 'slope',
      after: 'slope',
      cyclesBefore: 0,
      cyclesAfter: 0,
    });
  });

  it('a MUTED Cycles modifier is inert → extrapolation applies (as if absent)', () => {
    const muted = [cycles({ afterMode: 'repeat', muted: true })];
    expect(resolveExtend('hold', 'slope', muted)).toEqual({
      before: 'hold',
      after: 'slope',
      cyclesBefore: 0,
      cyclesAfter: 0,
    });
  });

  it('ignores non-Cycles modifiers (Noise) when resolving extend', () => {
    const noise: FModNoise = {
      type: 'noise',
      blend: 'add',
      strength: 1,
      scale: 1,
      phase: 0,
      offset: 0,
      depth: 1,
    };
    expect(resolveExtend('hold', 'hold', [noise])).toEqual({
      before: 'hold',
      after: 'hold',
      cyclesBefore: 0,
      cyclesAfter: 0,
    });
  });
});

describe('#280 — per-axis (independent) vec modifier stacks', () => {
  const gen10: FChannelModifier = { type: 'generator', additive: true, coefficients: [10] };
  // Flat vec3 channel: every component held at 5 across [0,4]. Base at any t = [5,5,5].
  const flat: Vec3Key[] = [
    { time: 0, value: [5, 5, 5], easing: 'linear' },
    { time: 4, value: [5, 5, 5], easing: 'linear' },
  ];

  it('modifiersForAxis: override (incl. empty) wins; null/undefined → shared', () => {
    const shared: FChannelModifier[] = [gen10];
    expect(modifiersForAxis(shared, [[gen10], null, null], 0)).toEqual([gen10]);
    expect(modifiersForAxis(shared, [[gen10], null, null], 1)).toBe(shared); // null → shared
    expect(modifiersForAxis(shared, [[], null, null], 0)).toEqual([]); // empty override wins
    expect(modifiersForAxis(shared, undefined, 0)).toBe(shared);
    expect(modifiersForAxis(shared, [null, null, null], 2)).toBe(shared);
  });

  it('an all-null axisModifiers falls back to the shared stack on every axis', () => {
    // Shared Generator +10 → 15 on all axes; an all-null override changes nothing.
    const shared = sampleVec3KeyframesExtended(flat, 1, 'hold', 'hold', 0, 0, [gen10]);
    const nulled = sampleVec3KeyframesExtended(
      flat,
      1,
      'hold',
      'hold',
      0,
      0,
      [gen10],
      [null, null, null],
    );
    expect(shared).toEqual([15, 15, 15]);
    expect(nulled).toEqual([15, 15, 15]);
  });

  it('a per-axis Generator on X alone moves ONLY X', () => {
    const out = sampleVec3KeyframesExtended(flat, 1, 'hold', 'hold', 0, 0, undefined, [
      [gen10],
      null,
      null,
    ]);
    expect(out).toEqual([15, 5, 5]);
  });

  it('an EMPTY per-axis override nulls the shared stack on that axis', () => {
    // Shared +10 applies to Y/Z (→15); X is overridden to an empty stack (→5, un-modified).
    const out = sampleVec3KeyframesExtended(
      flat,
      1,
      'hold',
      'hold',
      0,
      0,
      [gen10],
      [[], null, null],
    );
    expect(out).toEqual([5, 15, 15]);
  });

  it('a per-axis TIME modifier (Stepped) remaps only its axis’s sample time', () => {
    // Ramp [0,0,0]→[4,4,4]. A Stepped(step=2) on X snaps X's sample time; Y/Z stay linear.
    const ramp: Vec3Key[] = [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 4, value: [4, 4, 4], easing: 'linear' },
    ];
    const stepped: FChannelModifier = { type: 'stepped', step: 2, offset: 0 };
    // At t=3: X's time floors to 2 → X=2; Y/Z sample linearly → 3.
    const out = sampleVec3KeyframesExtended(ramp, 3, 'hold', 'hold', 0, 0, undefined, [
      [stepped],
      null,
      null,
    ]);
    expect(out[0]).toBeCloseTo(2, 9);
    expect(out[1]).toBeCloseTo(3, 9);
    expect(out[2]).toBeCloseTo(3, 9);
  });

  it('vec2: a per-axis Generator on Y alone moves ONLY Y', () => {
    const flat2: Vec2Key[] = [
      { time: 0, value: [5, 5], easing: 'linear' },
      { time: 4, value: [5, 5], easing: 'linear' },
    ];
    const out = sampleVec2KeyframesExtended(flat2, 1, 'hold', 'hold', 0, 0, undefined, [
      null,
      [gen10],
    ]);
    expect(out).toEqual([5, 15]);
  });
});

describe('#289 — per-axis (independent) extrapolation / Cycles', () => {
  // Ramp with distinct per-axis slopes: X rate 1, Y rate 2, Z rate 3 over [0,2].
  const ramp: Vec3Key[] = [
    { time: 0, value: [0, 0, 0], easing: 'linear' },
    { time: 2, value: [2, 4, 6], easing: 'linear' },
  ];
  const cycRepeat: FModCycles = {
    type: 'cycles',
    beforeMode: 'repeat',
    afterMode: 'repeat',
    beforeCycles: 0,
    afterCycles: 0,
  };

  it('buildPerAxisExtend: undefined when neither per-axis mods nor per-axis extend', () => {
    expect(buildPerAxisExtend(3, 'hold', 'slope', undefined, undefined, undefined)).toBeUndefined();
    expect(buildPerAxisExtend(3, 'hold', 'slope', [], undefined, undefined)).toBeUndefined();
  });

  it('buildPerAxisExtend: per-axis extrapolation override ?? channel-level, per axis', () => {
    const axisExtend: (AxisExtend | null)[] = [{ before: 'hold', after: 'slope' }, null, null];
    const resolved = buildPerAxisExtend(3, 'hold', 'hold', undefined, undefined, axisExtend)!;
    expect(resolved[0]).toEqual({
      before: 'hold',
      after: 'slope',
      cyclesBefore: 0,
      cyclesAfter: 0,
    });
    expect(resolved[1]).toEqual({ before: 'hold', after: 'hold', cyclesBefore: 0, cyclesAfter: 0 });
    expect(resolved[2]).toEqual({ before: 'hold', after: 'hold', cyclesBefore: 0, cyclesAfter: 0 });
  });

  it('a per-axis slope extrapolates ONLY its axis; the rest hold', () => {
    // X after=slope, Y/Z channel-level hold. At t=3 (1s past end): X=2+1=3; Y=4, Z=6 hold.
    const per = buildPerAxisExtend(3, 'hold', 'hold', undefined, undefined, [
      { before: 'hold', after: 'slope' },
      null,
      null,
    ]);
    const out = sampleVec3KeyframesExtended(
      ramp,
      3,
      'hold',
      'hold',
      0,
      0,
      undefined,
      undefined,
      per,
    );
    expect(out[0]).toBeCloseTo(3, 9);
    expect(out[1]).toBeCloseTo(4, 9);
    expect(out[2]).toBeCloseTo(6, 9);
  });

  it('a per-axis Cycles (in the axis stack) cycles ONLY its axis', () => {
    // X gets a Cycles(repeat) in its OWN stack; Y/Z hold. At t=3: X folds [0,2]→t1 → X=1.
    const axisMods = [[cycRepeat], null, null];
    const per = buildPerAxisExtend(3, 'hold', 'hold', undefined, axisMods, undefined);
    const out = sampleVec3KeyframesExtended(
      ramp,
      3,
      'hold',
      'hold',
      0,
      0,
      undefined,
      axisMods,
      per,
    );
    expect(out[0]).toBeCloseTo(1, 9); // cycled
    expect(out[1]).toBeCloseTo(4, 9); // held
    expect(out[2]).toBeCloseTo(6, 9); // held
  });

  it('CONSISTENCY CORRECTION: an explicit per-axis override REPLACES a shared Cycles', () => {
    // Shared Cycles(repeat) + an EMPTY override on X. #280 resolved Cycles from the shared
    // stack (X would cycle too); #289 lets the override replace it → X holds, Y/Z cycle.
    const shared = [cycRepeat];
    const axisMods = [[], null, null]; // X empty override (no Cycles)
    const per = buildPerAxisExtend(3, 'hold', 'hold', shared, axisMods, undefined);
    const out = sampleVec3KeyframesExtended(ramp, 3, 'hold', 'hold', 0, 0, shared, axisMods, per);
    expect(out[0]).toBeCloseTo(2, 9); // X held (override, no Cycles)
    expect(out[1]).toBeCloseTo(2, 9); // Y cycled (shared)
    expect(out[2]).toBeCloseTo(3, 9); // Z cycled (shared)
  });

  it('byte-fallback: per-axis mods but no per-axis extend → channel-level extrapolation', () => {
    // Channel extendAfter='slope', an empty X override, no per-axis extend → every axis still
    // slopes (extrapolation stays the channel-level fallback). Proves an empty modifier
    // override does NOT silently flip extrapolation.
    const axisMods = [[], null, null];
    const per = buildPerAxisExtend(3, 'hold', 'slope', undefined, axisMods, undefined);
    const out = sampleVec3KeyframesExtended(
      ramp,
      3,
      'hold',
      'slope',
      0,
      0,
      undefined,
      axisMods,
      per,
    );
    expect(out).toEqual([3, 6, 9]);
  });

  it('vec2: a per-axis slope on X alone extrapolates ONLY X', () => {
    const ramp2: Vec2Key[] = [
      { time: 0, value: [0, 0], easing: 'linear' },
      { time: 2, value: [2, 4], easing: 'linear' },
    ];
    const per = buildPerAxisExtend(2, 'hold', 'hold', undefined, undefined, [
      { before: 'hold', after: 'slope' },
      null,
    ]);
    const out = sampleVec2KeyframesExtended(
      ramp2,
      3,
      'hold',
      'hold',
      0,
      0,
      undefined,
      undefined,
      per,
    );
    expect(out[0]).toBeCloseTo(3, 9); // sloped
    expect(out[1]).toBeCloseTo(4, 9); // held
  });
});
