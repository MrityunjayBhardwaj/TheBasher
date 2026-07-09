import { describe, it, expect } from 'vitest';
import { overlayChannels, readAt, writeAt } from './overlayChannels';
import type {
  KeyframeChannelValue,
  KeyframeChannelNumberValue,
  KeyframeChannelVec3Value,
  KeyframeChannelColorValue,
  SceneChild,
  Vec3,
} from './types';

// Minimal channel-value builders (function-of-time, V24). `sample` ignores
// `seconds` here unless a test needs time-variance — the overlay contract is
// about WHERE/HOW the sampled value lands, not the interp math (that lives in
// keyframeInterp.test.ts).
const numCh = (paramPath: string, value: number): KeyframeChannelNumberValue => ({
  kind: 'KeyframeChannel',
  name: 'n',
  target: 't',
  paramPath,
  valueType: 'number',
  sample: () => value,
});
const vec3Ch = (paramPath: string, value: Vec3): KeyframeChannelVec3Value => ({
  kind: 'KeyframeChannel',
  name: 'v',
  target: 't',
  paramPath,
  valueType: 'vec3',
  sample: () => value,
});
const colorCh = (paramPath: string, value: string): KeyframeChannelColorValue => ({
  kind: 'KeyframeChannel',
  name: 'c',
  target: 't',
  paramPath,
  valueType: 'color',
  sample: () => value,
});

// A representative SceneChild base — a BoxMesh-shaped value with nested material.
const makeBox = (): SceneChild =>
  ({
    kind: 'BoxMesh',
    size: [1, 1, 1],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: { base: { color: '#000000', metalness: 0, roughness: 0.5 } },
  }) as unknown as SceneChild;

describe('overlayChannels — the lifted channel-overlay primitive (#196)', () => {
  it('returns null for a null base', () => {
    expect(overlayChannels(null, [numCh('x', 1)], 1, 0)).toBeNull();
  });

  it('returns the SAME base reference when there are no channels (clone avoided)', () => {
    const base = makeBox();
    expect(overlayChannels(base, [], 1, 0)).toBe(base);
  });

  it('does NOT mutate the base — overlays onto a clone', () => {
    const base = makeBox();
    const out = overlayChannels(base, [vec3Ch('position', [5, 6, 7])], 1, 0) as Record<
      string,
      unknown
    >;
    expect((base as Record<string, unknown>).position).toEqual([0, 0, 0]);
    expect(out.position).toEqual([5, 6, 7]);
    expect(out).not.toBe(base);
  });

  it('overlays a vec3 channel at a top-level paramPath (weight 1)', () => {
    const out = overlayChannels(makeBox(), [vec3Ch('position', [1, 2, 3])], 1, 0) as Record<
      string,
      unknown
    >;
    expect(out.position).toEqual([1, 2, 3]);
  });

  it('overlays a number channel at a NESTED dotted paramPath', () => {
    const out = overlayChannels(makeBox(), [numCh('material.base.metalness', 0.9)], 1, 0);
    expect(readAt(out as Record<string, unknown>, 'material.base.metalness')).toBe(0.9);
  });

  it('overlays a color (string) channel at weight 1', () => {
    const out = overlayChannels(makeBox(), [colorCh('material.base.color', '#ff8800')], 1, 0);
    expect(readAt(out as Record<string, unknown>, 'material.base.color')).toBe('#ff8800');
  });

  it('skips a channel with an empty paramPath (sentinel no-op)', () => {
    const base = makeBox();
    const out = overlayChannels(base, [numCh('', 1)], 1, 0) as Record<string, unknown>;
    // material untouched; position untouched.
    expect(out.position).toEqual([0, 0, 0]);
  });

  it('writes through an ARRAY-index segment (the Phase-3 materials path enabler)', () => {
    const base = {
      kind: 'GltfChild',
      materials: [{ base: { color: '#111111', roughness: 0.2 } }],
    } as unknown as SceneChild;
    const out = overlayChannels(base, [numCh('materials.0.base.roughness', 0.8)], 1, 0);
    expect(readAt(out as Record<string, unknown>, 'materials.0.base.roughness')).toBe(0.8);
  });

  describe('weight blending (parity with the legacy patchTarget blend)', () => {
    it('number at weight 0.5 → midpoint toward the channel value', () => {
      const base = { kind: 'X', n: 10 } as unknown as SceneChild;
      const out = overlayChannels(base, [numCh('n', 20)], 0.5, 0) as Record<string, unknown>;
      expect(out.n).toBe(15);
    });

    it('number at weight 0 → original base value', () => {
      const base = { kind: 'X', n: 10 } as unknown as SceneChild;
      const out = overlayChannels(base, [numCh('n', 20)], 0, 0) as Record<string, unknown>;
      expect(out.n).toBe(10);
    });

    it('vec3 at weight 0.5 → component-wise midpoint', () => {
      const out = overlayChannels(makeBox(), [vec3Ch('position', [2, 4, 6])], 0.5, 0) as Record<
        string,
        unknown
      >;
      expect(out.position).toEqual([1, 2, 3]);
    });

    it('color snaps at the half-weight mark (≥0.5 → channel, <0.5 → original)', () => {
      const base = makeBox();
      const lo = overlayChannels(base, [colorCh('material.base.color', '#ffffff')], 0.4, 0);
      const hi = overlayChannels(base, [colorCh('material.base.color', '#ffffff')], 0.6, 0);
      expect(readAt(lo as Record<string, unknown>, 'material.base.color')).toBe('#000000');
      expect(readAt(hi as Record<string, unknown>, 'material.base.color')).toBe('#ffffff');
    });
  });

  it('samples each channel at the given seconds (function-of-time)', () => {
    const ramp: KeyframeChannelValue = {
      kind: 'KeyframeChannel',
      name: 'r',
      target: 't',
      paramPath: 'material.base.metalness',
      valueType: 'number',
      sample: (s: number) => s * 0.1,
    };
    const at5 = overlayChannels(makeBox(), [ramp], 1, 5);
    expect(readAt(at5 as Record<string, unknown>, 'material.base.metalness')).toBeCloseTo(0.5);
  });
});

describe('multi-channel fold (#283 Phase 1 — the NLA reducer wiring)', () => {
  const box = () => ({ kind: 'BoxMesh', position: [0, 0, 0] }) as unknown as SceneChild;

  it('two Replace channels on one param → the TOP (higher order) wins, order-stable', () => {
    const lo = { ...vec3Ch('position', [1, 0, 0]), blendMode: 'replace' as const, order: 0 };
    const hi = { ...vec3Ch('position', [9, 0, 0]), blendMode: 'replace' as const, order: 1 };
    expect((overlayChannels(box(), [lo, hi], 1, 0) as Record<string, unknown>).position).toEqual([
      9, 0, 0,
    ]);
    // array-order INVARIANT: the `order` field decides, not scan order (V88 D3).
    expect((overlayChannels(box(), [hi, lo], 1, 0) as Record<string, unknown>).position).toEqual([
      9, 0, 0,
    ]);
  });

  it('two Combine channels on one param → ADDITIVE sum over the base (not last-wins)', () => {
    const a = { ...vec3Ch('position', [1, 0, 0]), blendMode: 'combine' as const, order: 0 };
    const b = { ...vec3Ch('position', [0, 2, 0]), blendMode: 'combine' as const, order: 1 };
    expect((overlayChannels(box(), [a, b], 1, 0) as Record<string, unknown>).position).toEqual([
      1, 2, 0,
    ]);
    // additive combine is order-invariant too (commutative)
    expect((overlayChannels(box(), [b, a], 1, 0) as Record<string, unknown>).position).toEqual([
      1, 2, 0,
    ]);
  });

  it('a bare channel (no blendMode/order) folds byte-identically to today (Replace @ order 0)', () => {
    const out = overlayChannels(box(), [vec3Ch('position', [3, 4, 5])], 1, 0) as Record<
      string,
      unknown
    >;
    expect(out.position).toEqual([3, 4, 5]);
  });

  it('scale param Combine MULTIPLIES (identity 1, detected by paramPath)', () => {
    const base = () => ({ kind: 'BoxMesh', scale: [2, 2, 2] }) as unknown as SceneChild;
    const s = { ...vec3Ch('scale', [3, 1, 1]), blendMode: 'combine' as const, order: 0 };
    expect((overlayChannels(base(), [s], 1, 0) as Record<string, unknown>).scale).toEqual([
      6, 2, 2,
    ]);
  });
});

describe('writeAt — the one shared path-writer (H40, re-exported from AnimationLayer)', () => {
  it('no-ops when an intermediate object is missing (path must pre-exist)', () => {
    const obj: Record<string, unknown> = { a: {} };
    writeAt(obj, 'a.missing.deep', 9);
    expect(obj).toEqual({ a: {} });
  });

  it('indexes array segments', () => {
    const obj: Record<string, unknown> = { arr: [{ v: 1 }] };
    writeAt(obj, 'arr.0.v', 2);
    expect((obj.arr as { v: number }[])[0].v).toBe(2);
  });
});
