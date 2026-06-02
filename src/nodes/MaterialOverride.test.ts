// MaterialOverride evaluator + schema tests.
//
// Pins:
//   - the per-field `overridden` set defaults `{}` (#124, V28 — legacy #99
//     map-aware behaviour, not value-equality);
//   - the coarse `ignoreSourceMaterial` flatten toggle defaults `false`
//     (#131, D-05 — a SEPARATE primitive from the per-field set);
//   - evaluate carries both onto the emitted MaterialValue so they flow down
//     the `override?: MaterialValue` prop chain to GltfAssetR.
//
// REF: PLAN.md Wave C (#124) + Wave E (#131); CONTEXT D-03/D-05; vyapti V28.

import { describe, expect, it } from 'vitest';
import { MaterialOverrideNode, MaterialOverrideParams } from './MaterialOverride';
import type { MaterialOverrideValue } from './types';

describe('MaterialOverride node', () => {
  it('defaults: overridden = {} and ignoreSourceMaterial = false (backward-compat)', () => {
    const params = MaterialOverrideParams.parse({});
    expect(params.overridden).toEqual({});
    expect(params.ignoreSourceMaterial).toBe(false);
  });

  it('evaluate carries the per-field set + flatten toggle onto MaterialValue', () => {
    const params = MaterialOverrideParams.parse({
      color: '#ff0000',
      metalness: 0,
      overridden: { metalness: true },
      ignoreSourceMaterial: true,
    });
    const value = MaterialOverrideNode.evaluate(params, {}) as MaterialOverrideValue;
    expect(value.material.color).toBe('#ff0000');
    expect(value.material.overridden).toEqual({ metalness: true });
    expect(value.material.ignoreSourceMaterial).toBe(true);
  });

  it('ignoreSourceMaterial is independent of the per-field set', () => {
    // Flatten with an empty per-field set is valid: flatten is coarse and
    // ignores the set entirely (the renderer replaces wholesale).
    const params = MaterialOverrideParams.parse({ ignoreSourceMaterial: true });
    expect(params.overridden).toEqual({});
    expect(params.ignoreSourceMaterial).toBe(true);
  });
});
