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
  it('gates the decorator to the three override consumers only', () => {
    expect(overrideDescriptor('MaterialOverride')?.fields).toContain('metalness');
    expect(overrideDescriptor('MaterialOverrideOp')?.fields).toContain('color');
    expect(overrideDescriptor('GltfChild')?.fields).toEqual(['position', 'rotation', 'scale']);
    expect(overrideDescriptor('BoxMesh')).toBeNull();
    expect(overrideDescriptor('Transform')).toBeNull();
  });

  it('#529 — MaterialOverrideOp covers ALL SIX fields, unlike its scene-band sibling', () => {
    // THE ENTRY THAT MAKES THE OPERATOR AUTHORABLE AT ALL. The data lane composes
    // 'authored-only', so a field with no bit is left to the layer below; without this
    // descriptor the panel would write the scalar and never the bit, and every edit to an
    // override operator would be silently discarded by the fold. Deleting this entry is a
    // total loss of function that no other test in the repo can see.
    const op = overrideDescriptor('MaterialOverrideOp')!;
    expect(op.fields).toEqual([
      'color',
      'roughness',
      'metalness',
      'opacity',
      'emissive',
      'emissiveIntensity',
    ]);
    expect(op.shape).toBe('sparse');
    expect(op.setParamPath).toBe('overridden');
  });

  it('the two material hosts differ EXACTLY where their regimes differ', () => {
    // Asserted as a relationship, not two independent lists, because the asymmetry is the
    // thing that has to stay true: the wrapper sits over a SOURCE material where the four
    // tints are always-applied with map-identity defaults (an inert bit, so no decorator);
    // the operator sits over ANOTHER AUTHORED LAYER where every bit is live. A future edit
    // that "tidied" these into one list would break one road or the other.
    const wrapper = overrideDescriptor('MaterialOverride')!.fields;
    const op = overrideDescriptor('MaterialOverrideOp')!.fields;
    expect(op.length).toBeGreaterThan(wrapper.length);
    for (const f of wrapper) expect(op).toContain(f);
    expect(op.filter((f) => !wrapper.includes(f)).sort()).toEqual([
      'color',
      'emissive',
      'emissiveIntensity',
      'opacity',
    ]);
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
