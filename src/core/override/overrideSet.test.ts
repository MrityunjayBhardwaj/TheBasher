import { describe, it, expect } from 'vitest';
import {
  isOverridden,
  withOverride,
  clearOverride,
  mergeOverridden,
  type OverriddenSet,
} from './overrideSet';

type Field = 'a' | 'b' | 'c';

describe('overrideSet — the shared authored-bit primitive (V28)', () => {
  describe('isOverridden — sparse semantics (absent ⇒ inherit source)', () => {
    it('returns false for an absent field', () => {
      const set: OverriddenSet<Field> = {};
      expect(isOverridden(set, 'a')).toBe(false);
    });

    it('returns false for an explicitly-false field', () => {
      const set: OverriddenSet<Field> = { a: false };
      expect(isOverridden(set, 'a')).toBe(false);
    });

    it('returns true only for an explicitly-true field', () => {
      const set: OverriddenSet<Field> = { a: true, b: false };
      expect(isOverridden(set, 'a')).toBe(true);
      expect(isOverridden(set, 'b')).toBe(false);
      expect(isOverridden(set, 'c')).toBe(false);
    });

    it('treats an undefined set as fully un-authored', () => {
      expect(isOverridden<Field>(undefined, 'a')).toBe(false);
    });

    it('reads a FULL boolean record (GltfChild shape) identically to a sparse one', () => {
      // GltfChild stores {position,rotation,scale} as a full record, not sparse.
      const full = { position: true, rotation: false, scale: false };
      expect(isOverridden(full, 'position')).toBe(true);
      expect(isOverridden(full, 'rotation')).toBe(false);
    });
  });

  describe('withOverride / clearOverride — immutable', () => {
    it('sets a bit without mutating the input', () => {
      const set: OverriddenSet<Field> = { a: false };
      const next = withOverride(set, 'a', true);
      expect(next.a).toBe(true);
      expect(set.a).toBe(false); // original untouched
      expect(next).not.toBe(set);
    });

    it('clearing keeps the key as false (read-equivalent to absent)', () => {
      const set: OverriddenSet<Field> = { a: true };
      const next = withOverride(set, 'a', false);
      expect(next.a).toBe(false);
      expect(isOverridden(next, 'a')).toBe(false);
    });

    it('clearOverride drops the key entirely (fully sparse)', () => {
      const set: OverriddenSet<Field> = { a: true, b: true };
      const next = clearOverride(set, 'a');
      expect('a' in next).toBe(false);
      expect(next.b).toBe(true);
      expect('a' in set).toBe(true); // original untouched
    });
  });

  describe('mergeOverridden — picks override ONLY where the bit is set', () => {
    const source = { a: 1, b: 2, c: 3 };
    const override = { a: 10, b: 20, c: 30 };
    const fields: Field[] = ['a', 'b', 'c'];

    it('empty set ⇒ all source (the legacy / backward-compat path)', () => {
      expect(mergeOverridden(source, override, {}, fields)).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('undefined set ⇒ all source', () => {
      expect(mergeOverridden(source, override, undefined, fields)).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('picks override only for set fields, source for the rest', () => {
      const set: OverriddenSet<Field> = { a: true, c: true };
      expect(mergeOverridden(source, override, set, fields)).toEqual({ a: 10, b: 2, c: 30 });
    });

    it('full set ⇒ all override', () => {
      const set: OverriddenSet<Field> = { a: true, b: true, c: true };
      expect(mergeOverridden(source, override, set, fields)).toEqual({ a: 10, b: 20, c: 30 });
    });

    it('does NOT derive from value-equality: source===override value still inherits when bit unset (R-4)', () => {
      // The whole point of V28: a field whose override value equals the source
      // value is STILL "source" unless its bit is explicitly set.
      const sameVal = { a: 5, b: 2, c: 3 };
      const ovrSame = { a: 5, b: 99, c: 3 };
      // 'a' has equal values but no bit → inherit source; 'b' differs but no bit → inherit source.
      expect(mergeOverridden(sameVal, ovrSame, {}, fields)).toEqual({ a: 5, b: 2, c: 3 });
      // only the explicit bit promotes a field, regardless of value equality.
      expect(mergeOverridden(sameVal, ovrSame, { b: true }, fields)).toEqual({ a: 5, b: 99, c: 3 });
    });

    it('is pure — mutates neither source nor override', () => {
      const s = { a: 1, b: 2, c: 3 };
      const o = { a: 10, b: 20, c: 30 };
      mergeOverridden(s, o, { a: true }, fields);
      expect(s).toEqual({ a: 1, b: 2, c: 3 });
      expect(o).toEqual({ a: 10, b: 20, c: 30 });
    });

    it('only considers listed fields; extra source keys pass through untouched', () => {
      const s = { a: 1, b: 2, c: 3, extra: 'keep' };
      const o = { a: 10, b: 20, c: 30, extra: 'drop' };
      const out = mergeOverridden(s, o, { a: true, extra: true } as OverriddenSet<string>, ['a']);
      expect(out).toEqual({ a: 10, b: 2, c: 3, extra: 'keep' }); // 'extra' not in fields → source kept
    });

    it('generalizes GltfChild manual band: ChildTrs-shaped Vec3 values', () => {
      // The real GltfChild use: source = lower-band-resolved TRS, override = node params.
      type TrsField = 'position' | 'rotation' | 'scale';
      const base = {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      };
      const node = {
        position: [5, 0, 0] as [number, number, number],
        rotation: [0, 90, 0] as [number, number, number],
        scale: [2, 2, 2] as [number, number, number],
      };
      const trsFields: TrsField[] = ['position', 'rotation', 'scale'];
      const out = mergeOverridden(base, node, { position: true }, trsFields);
      expect(out.position).toEqual([5, 0, 0]); // overridden
      expect(out.rotation).toEqual([0, 0, 0]); // inherits base
      expect(out.scale).toEqual([1, 1, 1]); // inherits base
    });
  });
});
