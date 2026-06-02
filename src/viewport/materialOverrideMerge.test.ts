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

describe('resolveMaterialOverrideFields — #124 per-field force (V28, explicit set ∪ map-aware)', () => {
  const allMapped = { roughnessMap: true, metalnessMap: true } as const;

  it('FORCES metalness over a metalnessMap when the field is in the authored set (the #124 GOAL)', () => {
    // The director deliberately flattens a textured METAL asset: metalness=0
    // must land the scalar even though a metalnessMap defends the channel.
    const flat = resolveMaterialOverrideFields({ ...override, metalness: 0 }, allMapped, {
      metalness: true,
    });
    expect(flat.metalness).toBe(0); // forced over the map
    expect(flat.roughness).toBeNull(); // roughness NOT in the set → map still defends
  });

  it('FORCES roughness over a roughnessMap when in the set, independently of metalness', () => {
    const fields = resolveMaterialOverrideFields({ ...override, roughness: 0.9 }, allMapped, {
      roughness: true,
    });
    expect(fields.roughness).toBe(0.9); // forced
    expect(fields.metalness).toBeNull(); // not forced → map defends
  });

  it('an UNSET field over a map still returns null (map defends — the #99 default holds, D-03)', () => {
    const fields = resolveMaterialOverrideFields(override, allMapped, { color: true });
    // color authored, but roughness/metalness untouched → both fall to map-aware.
    expect(fields.roughness).toBeNull();
    expect(fields.metalness).toBeNull();
  });

  it('an empty set is byte-identical to no set (backward-compat with the legacy signature)', () => {
    const noArg = resolveMaterialOverrideFields(override, allMapped);
    const emptySet = resolveMaterialOverrideFields(override, allMapped, {});
    expect(emptySet).toEqual(noArg);
    expect(emptySet.roughness).toBeNull();
    expect(emptySet.metalness).toBeNull();
  });

  it('a field=false in the set is treated as inherit (not forced) — explicit false ≡ absent', () => {
    const fields = resolveMaterialOverrideFields(override, allMapped, {
      metalness: false,
      roughness: true,
    });
    expect(fields.metalness).toBeNull(); // false → map defends
    expect(fields.roughness).toBe(0.5); // true → forced
  });

  it('forcing has no effect when there is no map anyway (procedural parity — value applies either way)', () => {
    const noMaps = { roughnessMap: false, metalnessMap: false } as const;
    const forced = resolveMaterialOverrideFields(override, noMaps, {
      roughness: true,
      metalness: true,
    });
    const unforced = resolveMaterialOverrideFields(override, noMaps);
    expect(forced.roughness).toBe(0.5);
    expect(forced.metalness).toBe(0);
    expect(forced).toEqual(unforced); // no map → set is a no-op
  });
});
