// GltfChild evaluator + schema tests — Phase 7.7 Wave A (issue #91).
//
// Pins the addressing-satellite contract:
//   - evaluate returns the GltfChildValue shape (kind, name, ref, TRS, flags);
//   - paramSchema rejects a missing childName / assetRef;
//   - `overridden` defaults all-false (the R-4 dirty signal, NOT value-equality);
//   - the type registers (getNodeType resolves after a re-seed).
//
// REF: PLAN.md Wave A (A1); CONTEXT 7.7 D-02/D-03; vyapti V1/V2/V22.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { GltfChildNode, GltfChildParams } from './GltfChild';
import type { GltfChildValue } from './types';

describe('GltfChild node', () => {
  it('evaluate returns the expected GltfChildValue shape', () => {
    const params = GltfChildParams.parse({
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
      assetRef: 'assets/skinned-bar.glb',
      childName: 'Bone',
    });
    const value = GltfChildNode.evaluate(params, {}) as GltfChildValue;
    expect(value).toEqual({
      kind: 'GltfChild',
      childName: 'Bone',
      assetRef: 'assets/skinned-bar.glb',
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
      overridden: { position: false, rotation: false, scale: false },
    });
  });

  it('overridden defaults all-false (the dirty signal, not value-equality)', () => {
    const params = GltfChildParams.parse({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      assetRef: 'a.glb',
      childName: 'X',
    });
    expect(params.overridden).toEqual({ position: false, rotation: false, scale: false });
  });

  it('preserves an explicitly-set overridden flag through parse + evaluate', () => {
    const params = GltfChildParams.parse({
      position: [5, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      overridden: { position: true, rotation: false, scale: false },
      assetRef: 'a.glb',
      childName: 'X',
    });
    const value = GltfChildNode.evaluate(params, {}) as GltfChildValue;
    expect(value.overridden).toEqual({ position: true, rotation: false, scale: false });
  });

  it('#188 — surfaces captured materials on the evaluated value (so the renderer reads EVALUATED, not raw params, H40)', () => {
    const params = GltfChildParams.parse({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      assetRef: 'a.glb',
      childName: 'Body',
      materials: [{ name: 'slot0', base: { color: '#ff0000', metalness: 0.2 } }],
    });
    const value = GltfChildNode.evaluate(params, {}) as GltfChildValue;
    expect(value.materials).toHaveLength(1);
    expect(value.materials?.[0].base.color).toBe('#ff0000');
    expect(value.materials?.[0].base.metalness).toBe(0.2);
  });

  it('#188 — materials is undefined when the child captured none (pre-#178 save / empty bone → V10/H14 fallback)', () => {
    const params = GltfChildParams.parse({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      assetRef: 'a.glb',
      childName: 'Axe_mesh',
    });
    const value = GltfChildNode.evaluate(params, {}) as GltfChildValue;
    expect(value.materials).toBeUndefined();
  });

  it('paramSchema rejects a missing childName', () => {
    expect(() =>
      GltfChildParams.parse({
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        assetRef: 'a.glb',
      }),
    ).toThrow();
  });

  it('paramSchema rejects a missing assetRef', () => {
    expect(() =>
      GltfChildParams.parse({
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        childName: 'X',
      }),
    ).toThrow();
  });

  it('is NOT a scene producer — no inputs, no outputs', () => {
    expect(GltfChildNode.inputs).toEqual({});
    expect(GltfChildNode.outputs).toEqual({});
  });

  describe('registration', () => {
    beforeEach(() => {
      __resetRegistryForTests();
      __reseedAllNodesForTests();
    });

    it("getNodeType('GltfChild') resolves after a re-seed", () => {
      expect(getNodeType('GltfChild')?.type).toBe('GltfChild');
    });
  });
});
