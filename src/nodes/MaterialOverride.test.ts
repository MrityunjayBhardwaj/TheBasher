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

  it('slotIndex defaults to undefined = whole-child (backward-compat) and carries when set', () => {
    // v0.6 #2 (#178, W6): absent slotIndex ⇒ undefined ⇒ the override applies to
    // EVERY material slot (the #99/#124 whole-child behaviour). A pre-W6 project
    // (no slotIndex key) MUST hydrate as undefined — no migration, no render shift.
    const whole = MaterialOverrideParams.parse({});
    expect(whole.slotIndex).toBeUndefined();
    const wholeVal = MaterialOverrideNode.evaluate(whole, {}) as MaterialOverrideValue;
    expect(wholeVal.material.slotIndex).toBeUndefined();

    // A number addresses ONE submesh slot; it rides the MaterialValue prop chain.
    const perSlot = MaterialOverrideParams.parse({ slotIndex: 1 });
    expect(perSlot.slotIndex).toBe(1);
    const perSlotVal = MaterialOverrideNode.evaluate(perSlot, {}) as MaterialOverrideValue;
    expect(perSlotVal.material.slotIndex).toBe(1);
  });

  it('ignoreSourceMaterial is independent of the per-field set', () => {
    // Flatten with an empty per-field set is valid: flatten is coarse and
    // ignores the set entirely (the renderer replaces wholesale).
    const params = MaterialOverrideParams.parse({ ignoreSourceMaterial: true });
    expect(params.overridden).toEqual({});
    expect(params.ignoreSourceMaterial).toBe(true);
  });
});
