import { describe, expect, it } from 'vitest';
import { foldChannelValue, type ChannelContribution } from './foldChannel';

const replace = (value: unknown, influence = 1): ChannelContribution => ({
  value,
  mode: 'replace',
  influence,
});
const combine = (value: unknown, influence = 1): ChannelContribution => ({
  value,
  mode: 'combine',
  influence,
});

describe('foldChannelValue', () => {
  describe('byte-identity anchors (Replace path == legacy overlayChannels blend)', () => {
    it('empty contribution list → base verbatim', () => {
      const base = [1, 2, 3];
      expect(foldChannelValue(base, [], 'vec3', 'position')).toBe(base);
    });

    it('single Replace @inf=1 → the strip value (last-writer parity)', () => {
      expect(foldChannelValue(10, [replace(20)], 'number', 'n')).toBe(20);
    });

    it('Replace number @0.5 → midpoint (10,20 → 15)', () => {
      expect(foldChannelValue(10, [replace(20, 0.5)], 'number', 'n')).toBe(15);
    });

    it('Replace number @0 → lower', () => {
      expect(foldChannelValue(10, [replace(20, 0)], 'number', 'n')).toBe(10);
    });

    it('Replace vec3 @0.5 → component-wise midpoint', () => {
      expect(foldChannelValue([0, 0, 0], [replace([2, 4, 6], 0.5)], 'vec3', 'position')).toEqual([
        1, 2, 3,
      ]);
    });

    it('Replace color snaps at the half-weight mark', () => {
      expect(
        foldChannelValue('#000000', [replace('#ffffff', 0.4)], 'color', 'material.color'),
      ).toBe('#000000');
      expect(
        foldChannelValue('#000000', [replace('#ffffff', 0.6)], 'color', 'material.color'),
      ).toBe('#ffffff');
    });
  });

  describe('order (bottom→top)', () => {
    it('Replace: the TOP (last) contribution wins at inf=1', () => {
      expect(foldChannelValue(0, [replace(5), replace(9)], 'number', 'n')).toBe(9);
      // reorder → different result (order-dependent, but DEFINED)
      expect(foldChannelValue(0, [replace(9), replace(5)], 'number', 'n')).toBe(5);
    });

    it('Combine additive: order-INVARIANT sum', () => {
      const a = foldChannelValue(0, [combine(2), combine(3)], 'number', 'n');
      const b = foldChannelValue(0, [combine(3), combine(2)], 'number', 'n');
      expect(a).toBe(5);
      expect(b).toBe(5);
    });
  });

  describe('Combine — per-type identity (I-4)', () => {
    it('number additive: lower + strip·inf (identity 0)', () => {
      expect(foldChannelValue(5, [combine(3)], 'number', 'n')).toBe(8);
      expect(foldChannelValue(5, [combine(3, 0.5)], 'number', 'n')).toBe(6.5);
    });

    it('full-influence Combine over the empty (identity) stack reproduces the source', () => {
      // additive identity is 0 → 0 + 7·1 = 7
      expect(foldChannelValue(0, [combine(7)], 'number', 'position')).toBe(7);
      // two position channels on one box → ADDITIVE SUM, not last-wins (the §6 observation)
      expect(
        foldChannelValue([1, 2, 3], [combine([1, 0, 0]), combine([0, 1, 0])], 'vec3', 'position'),
      ).toEqual([2, 3, 3]);
    });

    it('scale param → MULTIPLY (identity 1), detected by paramPath', () => {
      expect(foldChannelValue([2, 2, 2], [combine([3, 1, 1])], 'vec3', 'scale')).toEqual([6, 2, 2]);
      // full-influence scale over identity(1) reproduces the source
      expect(foldChannelValue([1, 1, 1], [combine([4, 5, 6])], 'vec3', 'scale')).toEqual([4, 5, 6]);
      // nested scale path
      expect(foldChannelValue([2, 2, 2], [combine([2, 2, 2])], 'vec3', 'root.scale')).toEqual([
        4, 4, 4,
      ]);
    });
  });

  describe('Combine — quaternion manifold (I-5)', () => {
    const Z90 = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const; // 90° about Z
    const ID = [0, 0, 0, 1] as const;

    it('full-influence Combine over identity-quat reproduces the source', () => {
      const out = foldChannelValue([...ID], [combine([...Z90])], 'quat', 'rotation') as number[];
      out.forEach((x, i) => expect(x).toBeCloseTo(Z90[i], 6));
    });

    it('stacking two quats stays on the unit manifold (len ≈ 1)', () => {
      const out = foldChannelValue(
        [...ID],
        [combine([...Z90]), combine([...Z90])],
        'quat',
        'rotation',
      ) as number[];
      const len = Math.hypot(...out);
      expect(len).toBeCloseTo(1, 6);
      // 90° ⊗ 90° about Z = 180° about Z → [0,0,1,0] (up to sign)
      expect(Math.abs(out[2])).toBeCloseTo(1, 5);
      expect(out[3]).toBeCloseTo(0, 5);
    });

    it('Replace quat @inf=1 → strip (slerp(a,b,1) === b — default-weight byte-identity)', () => {
      const out = foldChannelValue([...ID], [replace([...Z90])], 'quat', 'rotation') as number[];
      out.forEach((x, i) => expect(x).toBeCloseTo(Z90[i], 6));
    });
  });

  describe('short-circuits', () => {
    it('inf == 0 contribution vanishes (muted / zero-weight)', () => {
      expect(foldChannelValue(5, [combine(100, 0)], 'number', 'n')).toBe(5);
      expect(foldChannelValue(5, [replace(100, 0)], 'number', 'n')).toBe(5);
    });

    it('discrete Combine (text/image) degrades to Replace (no manifold algebra)', () => {
      expect(foldChannelValue('a', [combine('b')], 'text', 'prompt')).toBe('b');
      expect(foldChannelValue('a', [combine('b', 0.4)], 'text', 'prompt')).toBe('a');
    });
  });
});
