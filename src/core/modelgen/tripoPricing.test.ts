// The cost estimate (#1720), checked against the table it transcribes:
// ref/sources/tripo-3d-for-blender/utils.py:244-272 (`calculate_generation_price`).

import { describe, expect, it } from 'vitest';
import { estimateModelGenerationCost, estimateTripoCredits } from './tripoPricing';

describe('estimateTripoCredits — the add-on table, rule for rule', () => {
  it('a v3 text run is 10 + 10', () => {
    expect(estimateTripoCredits({ source: 'text', modelVersion: 'v3.1-20260211' })).toBe(20);
  });

  it('an image adds 10', () => {
    expect(estimateTripoCredits({ source: 'image', modelVersion: 'v3.1-20260211' })).toBe(30);
    expect(estimateTripoCredits({ source: 'multiview', modelVersion: 'v3.1-20260211' })).toBe(30);
  });

  it('a v2 run adds texture (on by default), detailed texture, detailed geometry and quads', () => {
    const v2 = { source: 'text' as const, modelVersion: 'v2.5-20250123' };
    expect(estimateTripoCredits(v2)).toBe(20);
    expect(estimateTripoCredits({ ...v2, texture: false, pbr: false })).toBe(10);
    expect(estimateTripoCredits({ ...v2, textureQuality: 'detailed' })).toBe(30);
    expect(estimateTripoCredits({ ...v2, geometryQuality: 'detailed' })).toBe(40);
    expect(estimateTripoCredits({ ...v2, quad: true })).toBe(25);
  });
});

describe('estimateModelGenerationCost', () => {
  it('multiplies by the runs and says when rigging is not priced', () => {
    const text = { source: 'text' as const, modelVersion: 'v3.1-20260211' };
    expect(estimateModelGenerationCost(text, 4, false)).toEqual({
      perRun: 20,
      total: 80,
      runs: 4,
      rigPriced: true,
    });
    expect(estimateModelGenerationCost(text, 4, true).rigPriced).toBe(false);
  });
});
