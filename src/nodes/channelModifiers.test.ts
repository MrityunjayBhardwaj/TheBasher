// channelModifiers — the per-channel F-Modifier stack (#274, V88 D2). Proves:
// PURITY (deterministic noise), byte-identity for an empty stack, the blend modes,
// influence + restricted-range blending, and mute.
import { describe, expect, it } from 'vitest';
import {
  applyChannelModifiers,
  resolveSampleTime,
  fractalNoise,
  defaultModifier,
  type FModNoise,
  type FModGenerator,
  type FModLimits,
  type FModStepped,
} from './channelModifiers';
import { sampleScalarKeyframesExtended, type ScalarKey } from './keyframeInterp';

const noise = (over: Partial<FModNoise> = {}): FModNoise => ({
  type: 'noise',
  blend: 'add',
  strength: 1,
  scale: 1,
  phase: 0,
  offset: 0,
  depth: 1,
  ...over,
});

describe('fractalNoise — deterministic, bounded', () => {
  it('is a pure function of x (same input → same output)', () => {
    expect(fractalNoise(3.14, 2)).toBe(fractalNoise(3.14, 2));
  });
  it('stays within ~[-1, 1]', () => {
    for (let i = 0; i < 200; i++) {
      const v = fractalNoise(i * 0.37, 3);
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
  });
  it('actually varies over time (not a constant)', () => {
    const a = fractalNoise(1.0, 1);
    const b = fractalNoise(1.5, 1);
    expect(a).not.toBeCloseTo(b, 6);
  });
});

describe('applyChannelModifiers — stack semantics', () => {
  it('empty / undefined stack → base verbatim (byte-identical)', () => {
    expect(applyChannelModifiers(42, 1.23, [])).toBe(42);
    expect(applyChannelModifiers(42, 1.23, undefined)).toBe(42);
  });

  it('ADD blend offsets the base by the noise signal (bounded, deterministic)', () => {
    const mods = [noise({ strength: 5 })];
    const v = applyChannelModifiers(10, 0.7, mods);
    expect(v).not.toBe(10);
    expect(Math.abs(v - 10)).toBeLessThanOrEqual(5.0001); // |noise|·strength ≤ 5
    expect(applyChannelModifiers(10, 0.7, mods)).toBe(v); // pure
  });

  it('REPLACE blend ignores the base (returns the noise signal)', () => {
    const mods = [noise({ blend: 'replace', strength: 3 })];
    expect(applyChannelModifiers(100, 0.4, mods)).toBe(applyChannelModifiers(-100, 0.4, mods));
  });

  it('muted modifier is a no-op', () => {
    expect(applyChannelModifiers(10, 0.7, [noise({ strength: 5, muted: true })])).toBe(10);
  });

  it('influence blends between base and modified (0 → base, 0.5 → halfway)', () => {
    const full = applyChannelModifiers(10, 0.7, [noise({ strength: 5, influence: 1 })]);
    const half = applyChannelModifiers(10, 0.7, [noise({ strength: 5, influence: 0.5 })]);
    const none = applyChannelModifiers(10, 0.7, [noise({ strength: 5, influence: 0 })]);
    expect(none).toBe(10);
    expect(half).toBeCloseTo(10 + (full - 10) * 0.5, 9);
  });

  it('restricted range zeroes the effect outside [start,end], ramps blend-in', () => {
    const mods = [noise({ strength: 5, useRange: true, rangeStart: 1, rangeEnd: 2, blendIn: 0.5 })];
    expect(applyChannelModifiers(10, 0.5, mods)).toBe(10); // before range
    expect(applyChannelModifiers(10, 2.5, mods)).toBe(10); // after range
    // At the very start of the blend-in ramp the influence is 0.
    expect(applyChannelModifiers(10, 1.0, mods)).toBe(10);
    // Mid-range (past blend-in) the effect is live.
    expect(applyChannelModifiers(10, 1.7, mods)).not.toBe(10);
  });

  it('defaultModifier(noise) is a gentle additive jitter', () => {
    const m = defaultModifier('noise');
    expect(m.type).toBe('noise');
    expect(m).toMatchObject({ blend: 'add', strength: 1, scale: 1, depth: 1 });
  });
});

describe('modifiers through the sampler (H40 — one band, all consumers)', () => {
  const keys: ScalarKey[] = [
    { time: 0, value: 0, easing: 'linear' },
    { time: 2, value: 10, easing: 'linear' },
  ];

  it('empty modifiers → identical to the pre-#274 extended sample', () => {
    for (const t of [0.5, 1, 1.5]) {
      expect(sampleScalarKeyframesExtended(keys, t, 'hold', 'hold', 0, 0, [])).toBe(
        sampleScalarKeyframesExtended(keys, t, 'hold', 'hold', 0, 0),
      );
    }
  });

  it('a noise modifier deviates the sampled value from the clean curve', () => {
    const clean = sampleScalarKeyframesExtended(keys, 1, 'hold', 'hold', 0, 0);
    const noisy = sampleScalarKeyframesExtended(keys, 1, 'hold', 'hold', 0, 0, [
      noise({ strength: 3 }),
    ]);
    expect(noisy).not.toBe(clean);
    expect(Math.abs(noisy - clean)).toBeLessThanOrEqual(3.0001);
  });
});

// ── #276 — value-phase modifiers: Generator (polynomial) + Limits (value clamp) ──

const generator = (over: Partial<FModGenerator> = {}): FModGenerator => ({
  type: 'generator',
  additive: true,
  coefficients: [0, 1],
  ...over,
});
const limits = (over: Partial<FModLimits> = {}): FModLimits => ({
  type: 'limits',
  useMinY: false,
  useMaxY: false,
  minY: 0,
  maxY: 1,
  ...over,
});

describe('#276 Generator modifier — polynomial of time', () => {
  it('ADDITIVE adds c0 + c1·t + c2·t² to the incoming value', () => {
    // y = 2 + 3t + 4t²; at t=2 → 2 + 6 + 16 = 24; additive over base 10 → 34.
    expect(applyChannelModifiers(10, 2, [generator({ coefficients: [2, 3, 4] })])).toBeCloseTo(
      34,
      9,
    );
  });

  it('REPLACE (additive=false) discards the base, becomes the polynomial', () => {
    expect(
      applyChannelModifiers(999, 2, [generator({ additive: false, coefficients: [2, 3, 4] })]),
    ).toBeCloseTo(24, 9);
  });

  it('an empty coefficient list contributes 0 (additive → base unchanged)', () => {
    expect(applyChannelModifiers(7, 3, [generator({ coefficients: [] })])).toBe(7);
  });

  it('influence blends the generated value over the base', () => {
    // additive c0=10 at influence 0.5 → base + 0.5·10.
    expect(
      applyChannelModifiers(0, 0, [generator({ coefficients: [10], influence: 0.5 })]),
    ).toBeCloseTo(5, 9);
  });

  it('is pure (same t,params → same value) and defaultModifier is a unit ramp', () => {
    const g = defaultModifier('generator') as FModGenerator;
    expect(g).toMatchObject({ type: 'generator', additive: true, coefficients: [0, 1] });
    expect(applyChannelModifiers(0, 3, [g])).toBe(applyChannelModifiers(0, 3, [g]));
    expect(applyChannelModifiers(0, 3, [g])).toBeCloseTo(3, 9); // y = t
  });
});

describe('#276 Limits modifier — value (Y) clamp', () => {
  it('clamps ABOVE the max and BELOW the min, each independently', () => {
    expect(applyChannelModifiers(100, 0, [limits({ useMaxY: true, maxY: 60 })])).toBe(60);
    expect(applyChannelModifiers(-5, 0, [limits({ useMinY: true, minY: 0 })])).toBe(0);
    // inside the band → untouched.
    expect(applyChannelModifiers(30, 0, [limits({ useMinY: true, useMaxY: true, maxY: 60 })])).toBe(
      30,
    );
  });

  it('a disabled bound does nothing (byte-identical to the base)', () => {
    expect(applyChannelModifiers(500, 0, [limits({ useMaxY: false, maxY: 1 })])).toBe(500);
    expect(applyChannelModifiers(500, 0, [defaultModifier('limits')])).toBe(500); // both off on add
  });

  it('influence gives a SOFT clamp (blend between clamped and raw)', () => {
    // raw 100, clamped 60, influence 0.5 → 100 + 0.5·(60−100) = 80.
    expect(
      applyChannelModifiers(100, 0, [limits({ useMaxY: true, maxY: 60, influence: 0.5 })]),
    ).toBeCloseTo(80, 9);
  });

  it('composes AFTER a generator in the stack (clamp the generated ramp)', () => {
    // additive ramp y=t over base 0 at t=100 → 100, then clamp to 60.
    const mods = [generator({ coefficients: [0, 1] }), limits({ useMaxY: true, maxY: 60 })];
    expect(applyChannelModifiers(0, 100, mods)).toBe(60);
  });
});

describe('#276 through the sampler — value modifiers deviate render, empty stack byte-identical', () => {
  const keys: ScalarKey[] = [
    { time: 0, value: 0, easing: 'linear' },
    { time: 2, value: 10, easing: 'linear' },
  ];
  it('a generator shifts the sampled value; no modifiers = the clean curve', () => {
    const clean = sampleScalarKeyframesExtended(keys, 1, 'hold', 'hold', 0, 0);
    const gen = sampleScalarKeyframesExtended(keys, 1, 'hold', 'hold', 0, 0, [
      generator({ additive: true, coefficients: [5] }),
    ]);
    expect(gen).toBeCloseTo(clean + 5, 9);
    expect(sampleScalarKeyframesExtended(keys, 1, 'hold', 'hold', 0, 0, [])).toBe(clean);
  });
});

// ── #277 — time-phase modifiers: Stepped + Limits-X via resolveSampleTime ──

const stepped = (over: Partial<FModStepped> = {}): FModStepped => ({
  type: 'stepped',
  step: 1,
  offset: 0,
  ...over,
});

describe('#277 resolveSampleTime — time phase remaps the sample time', () => {
  it('is identity for an empty / value-only stack (bit-for-bit)', () => {
    expect(resolveSampleTime(1.7, [])).toBe(1.7);
    expect(resolveSampleTime(1.7, undefined)).toBe(1.7);
    expect(resolveSampleTime(1.7, [noise({ strength: 5 })])).toBe(1.7);
    expect(resolveSampleTime(1.7, [generator({ coefficients: [3] })])).toBe(1.7);
  });

  it('Stepped snaps t to offset + floor((t-offset)/step)·step', () => {
    expect(resolveSampleTime(1.4, [stepped({ step: 1 })])).toBe(1);
    expect(resolveSampleTime(1.9, [stepped({ step: 1 })])).toBe(1);
    expect(resolveSampleTime(2.0, [stepped({ step: 1 })])).toBe(2);
    // step 0.5 → grid at .0/.5; offset shifts the grid.
    expect(resolveSampleTime(1.4, [stepped({ step: 0.5 })])).toBeCloseTo(1.0, 9);
    expect(resolveSampleTime(1.7, [stepped({ step: 0.5, offset: 0.2 })])).toBeCloseTo(1.7, 9);
    expect(resolveSampleTime(1.6, [stepped({ step: 0.5, offset: 0.2 })])).toBeCloseTo(1.2, 9);
  });

  it('Stepped with step <= 0 is an identity guard (no divide)', () => {
    expect(resolveSampleTime(1.4, [stepped({ step: 0 })])).toBe(1.4);
    expect(resolveSampleTime(1.4, [stepped({ step: -2 })])).toBe(1.4);
  });

  it('Stepped frame range: outside [start,end] passes through unstepped', () => {
    const s = stepped({ step: 1, useFrameRange: true, frameStart: 2, frameEnd: 5 });
    expect(resolveSampleTime(1.4, [s])).toBe(1.4); // before range — unstepped
    expect(resolveSampleTime(6.4, [s])).toBe(6.4); // after range — unstepped
    expect(resolveSampleTime(3.4, [s])).toBe(3); // inside — stepped
  });

  it('a muted time modifier is skipped (identity)', () => {
    expect(resolveSampleTime(1.4, [stepped({ step: 1, muted: true })])).toBe(1.4);
    expect(resolveSampleTime(9, [limits({ useMaxX: true, maxX: 3, muted: true })])).toBe(9);
  });

  it('Limits-X clamps the time below min / above max, each independent', () => {
    expect(resolveSampleTime(9, [limits({ useMaxX: true, maxX: 3 })])).toBe(3);
    expect(resolveSampleTime(-2, [limits({ useMinX: true, minX: 0 })])).toBe(0);
    expect(
      resolveSampleTime(1.5, [limits({ useMinX: true, useMaxX: true, minX: 0, maxX: 3 })]),
    ).toBe(1.5);
    // Both X bounds off → identity (byte-identical); default limits has X off.
    expect(resolveSampleTime(9, [limits({ useMaxX: false, maxX: 3 })])).toBe(9);
    expect(resolveSampleTime(9, [defaultModifier('limits')])).toBe(9);
  });

  it('composes time modifiers in array order (Stepped then Limits-X)', () => {
    // snap 9.4 → 9, then clamp to maxX 3 → 3.
    const mods = [stepped({ step: 1 }), limits({ useMaxX: true, maxX: 3 })];
    expect(resolveSampleTime(9.4, mods)).toBe(3);
  });
});

describe('#277 through the sampler — time modifiers remap render; empty byte-identical', () => {
  const keys: ScalarKey[] = [
    { time: 0, value: 0, easing: 'linear' },
    { time: 4, value: 40, easing: 'linear' }, // value = 10·t on [0,4]
  ];

  it('Stepped HOLDS the curve across each step (render at 1.4 == render at 1.0)', () => {
    const held = sampleScalarKeyframesExtended(keys, 1.4, 'hold', 'hold', 0, 0, [
      stepped({ step: 1 }),
    ]);
    const at1 = sampleScalarKeyframesExtended(keys, 1.0, 'hold', 'hold', 0, 0);
    expect(held).toBeCloseTo(at1, 9); // both 10
    // and it actually differs from the un-stepped curve at 1.4 (which would be 14).
    const clean = sampleScalarKeyframesExtended(keys, 1.4, 'hold', 'hold', 0, 0);
    expect(held).not.toBeCloseTo(clean, 6);
  });

  it('Limits-X constant-extrapolates: render past maxX == render at maxX', () => {
    const past = sampleScalarKeyframesExtended(keys, 3.5, 'hold', 'hold', 0, 0, [
      limits({ useMaxX: true, maxX: 2 }),
    ]);
    const atMax = sampleScalarKeyframesExtended(keys, 2, 'hold', 'hold', 0, 0);
    expect(past).toBeCloseTo(atMax, 9); // both 20 — held at the X limit
  });

  it('Blender-faithful: Stepped also steps a downstream Noise (value phase sees st)', () => {
    // Noise sampled at the stepped time → its value at 1.4 equals its value at 1.0.
    const mods = [stepped({ step: 1 }), noise({ strength: 5 })];
    const at14 = sampleScalarKeyframesExtended(keys, 1.4, 'hold', 'hold', 0, 0, mods);
    const at10 = sampleScalarKeyframesExtended(keys, 1.0, 'hold', 'hold', 0, 0, mods);
    expect(at14).toBeCloseTo(at10, 9);
  });

  it('falsify: empty stack + muted stepped revert to the byte-identical base', () => {
    const clean = sampleScalarKeyframesExtended(keys, 1.4, 'hold', 'hold', 0, 0);
    expect(sampleScalarKeyframesExtended(keys, 1.4, 'hold', 'hold', 0, 0, [])).toBe(clean);
    expect(
      sampleScalarKeyframesExtended(keys, 1.4, 'hold', 'hold', 0, 0, [
        stepped({ step: 1, muted: true }),
      ]),
    ).toBe(clean);
  });
});
