// channelModifiers — the per-channel F-Modifier stack (#274, V88 D2). Proves:
// PURITY (deterministic noise), byte-identity for an empty stack, the blend modes,
// influence + restricted-range blending, and mute.
import { describe, expect, it } from 'vitest';
import {
  applyChannelModifiers,
  fractalNoise,
  defaultModifier,
  type FModNoise,
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
