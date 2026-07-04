// channelModifiers — the per-channel F-Modifier stack (#274, V88 D2). Proves:
// PURITY (deterministic noise), byte-identity for an empty stack, the blend modes,
// influence + restricted-range blending, and mute.
import { describe, expect, it } from 'vitest';
import {
  applyChannelModifiers,
  fractalNoise,
  defaultModifier,
  type FModNoise,
  type FModGenerator,
  type FModLimits,
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
