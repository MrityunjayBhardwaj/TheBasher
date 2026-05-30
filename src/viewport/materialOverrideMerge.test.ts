// materialOverrideMerge — unit proof of the D-01 map-aware tint rule (#99 / P7.13).
//
// The pure decision layer: given an override material + which maps the source
// carries, which fields does the renderer overlay onto the cloned material?
// Both branches are exercised — the whole point of #99's fix is that mapped
// scalar channels are NOT stomped by override defaults.

import { describe, it, expect } from 'vitest';
import { resolveMaterialOverrideFields } from './materialOverrideMerge';
import type { MaterialValue } from '../nodes/types';

const override: MaterialValue = {
  kind: 'Material',
  name: 'override',
  color: '#ff0000',
  roughness: 0.5,
  metalness: 0,
  opacity: 0.8,
  emissive: '#112233',
  emissiveIntensity: 2,
};

describe('resolveMaterialOverrideFields (D-01 map-aware tint)', () => {
  it('leaves roughness/metalness as null when the source carries the corresponding map', () => {
    const fields = resolveMaterialOverrideFields(override, {
      roughnessMap: true,
      metalnessMap: true,
    });
    // The source map owns the channel — the scalar must NOT overwrite it.
    expect(fields.roughness).toBeNull();
    expect(fields.metalness).toBeNull();
  });

  it('passes roughness/metalness through when the source has no map (procedural parity)', () => {
    const fields = resolveMaterialOverrideFields(override, {
      roughnessMap: false,
      metalnessMap: false,
    });
    expect(fields.roughness).toBe(0.5);
    expect(fields.metalness).toBe(0);
  });

  it('gates each scalar independently on its own map', () => {
    const fields = resolveMaterialOverrideFields(override, {
      roughnessMap: true,
      metalnessMap: false,
    });
    expect(fields.roughness).toBeNull(); // roughnessMap present → keep source
    expect(fields.metalness).toBe(0); // no metalnessMap → apply override
  });

  it('always applies color / emissive / emissiveIntensity / opacity regardless of maps', () => {
    const withMaps = resolveMaterialOverrideFields(override, {
      roughnessMap: true,
      metalnessMap: true,
    });
    const noMaps = resolveMaterialOverrideFields(override, {
      roughnessMap: false,
      metalnessMap: false,
    });
    for (const fields of [withMaps, noMaps]) {
      expect(fields.color).toBe('#ff0000');
      expect(fields.emissive).toBe('#112233');
      expect(fields.emissiveIntensity).toBe(2);
      expect(fields.opacity).toBe(0.8);
    }
  });

  it('sets transparent when opacity < 1 and clears it at full opacity', () => {
    const translucent = resolveMaterialOverrideFields(override, {
      roughnessMap: false,
      metalnessMap: false,
    });
    expect(translucent.transparent).toBe(true); // opacity 0.8

    const opaque = resolveMaterialOverrideFields(
      { ...override, opacity: 1 },
      { roughnessMap: false, metalnessMap: false },
    );
    expect(opaque.transparent).toBe(false);
  });

  it('never returns map references (maps survive via clone, not via the merge)', () => {
    const fields = resolveMaterialOverrideFields(override, {
      roughnessMap: false,
      metalnessMap: false,
    });
    expect(Object.keys(fields).sort()).toEqual(
      [
        'color',
        'emissive',
        'emissiveIntensity',
        'metalness',
        'opacity',
        'roughness',
        'transparent',
      ].sort(),
    );
  });
});
