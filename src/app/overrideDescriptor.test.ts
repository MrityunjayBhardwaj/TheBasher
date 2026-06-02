// overrideDescriptor tests (#130 / Wave D) — the gate + the schema-respecting
// revert. Pins:
//   - the decorator is gated to the covered fields only (no over-reach);
//   - sparse revert (MaterialOverride) DROPS the key (clearOverride);
//   - record revert (GltfChild) KEEPS the key as false (withOverride) so the
//     fixed-key zod object stays valid;
//   - both revert shapes read as not-overridden.

import { describe, expect, it } from 'vitest';
import { isOverridden } from '../core/override/overrideSet';
import {
  buildRevertedSet,
  isFieldOverridden,
  overrideDescriptor,
  readOverriddenSet,
} from './overrideDescriptor';

describe('overrideDescriptor', () => {
  it('gates the decorator to the two override consumers only', () => {
    expect(overrideDescriptor('MaterialOverride')?.fields).toContain('metalness');
    expect(overrideDescriptor('GltfChild')?.fields).toEqual(['position', 'rotation', 'scale']);
    expect(overrideDescriptor('BoxMesh')).toBeNull();
    expect(overrideDescriptor('Transform')).toBeNull();
  });

  it('MaterialOverride covers ONLY the bit-consulting fields (roughness/metalness)', () => {
    // color/opacity/emissive/emissiveIntensity are always-applied tints — their
    // authored bit is inert in resolveMaterialOverrideFields, so a decorator
    // there would imply an inherit-vs-override choice that does not exist.
    const d = overrideDescriptor('MaterialOverride')!;
    expect(d.fields).toEqual(['roughness', 'metalness']);
    expect(d.fields).not.toContain('color');
    expect(d.fields).not.toContain('opacity');
    expect(d.fields).not.toContain('emissive');
  });

  it('does not cover non-override params (name / ignoreSourceMaterial / assetRef)', () => {
    const d = overrideDescriptor('MaterialOverride')!;
    expect(d.fields).not.toContain('name');
    expect(d.fields).not.toContain('ignoreSourceMaterial');
    const g = overrideDescriptor('GltfChild')!;
    expect(g.fields).not.toContain('assetRef');
    expect(g.fields).not.toContain('childName');
  });

  it('isFieldOverridden reads the explicit bit (absent ⇒ false)', () => {
    const d = overrideDescriptor('MaterialOverride')!;
    expect(isFieldOverridden({ overridden: { metalness: true } }, d, 'metalness')).toBe(true);
    expect(isFieldOverridden({ overridden: { metalness: true } }, d, 'roughness')).toBe(false);
    expect(isFieldOverridden({}, d, 'metalness')).toBe(false);
    expect(isFieldOverridden(undefined, d, 'metalness')).toBe(false);
  });

  it('sparse revert (MaterialOverride) drops the key', () => {
    const d = overrideDescriptor('MaterialOverride')!;
    const next = buildRevertedSet({ metalness: true, roughness: true }, d, 'metalness');
    expect('metalness' in next).toBe(false); // dropped — stays minimal
    expect(next.roughness).toBe(true); // siblings untouched
    expect(isOverridden(next, 'metalness')).toBe(false);
  });

  it('record revert (GltfChild) keeps the key as false (fixed-key zod object)', () => {
    const d = overrideDescriptor('GltfChild')!;
    const next = buildRevertedSet({ position: true, rotation: false, scale: false }, d, 'position');
    expect('position' in next).toBe(true); // KEY KEPT — zod object requires it
    expect(next.position).toBe(false);
    expect(next.rotation).toBe(false);
    expect(isOverridden(next, 'position')).toBe(false);
  });

  it('readOverriddenSet defaults to empty for absent / malformed params', () => {
    expect(readOverriddenSet(undefined, 'overridden')).toEqual({});
    expect(readOverriddenSet({ overridden: 'nope' }, 'overridden')).toEqual({});
    expect(readOverriddenSet({ overridden: { metalness: true } }, 'overridden')).toEqual({
      metalness: true,
    });
  });
});
