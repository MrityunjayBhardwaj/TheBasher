// GltfAsset param/value tests — Phase 7.7 Wave A3 (issue #91).
//
// Pins the additive childHierarchy field: it threads through evaluate, and
// a pre-7.7 saved node (no childHierarchy) hydrates clean with an empty map
// (V10 / H14 back-compat — no schema-version bump).
//
// REF: PLAN.md Wave A (A3); CONTEXT 7.7 D-02; vyapti V10.

import { describe, expect, it } from 'vitest';
import { GltfAssetNode, GltfAssetParams } from './GltfAsset';
import type { GltfAssetValue } from './types';

describe('GltfAsset childHierarchy (#91 A3)', () => {
  it('threads childHierarchy through evaluate into the value', () => {
    const params = GltfAssetParams.parse({
      assetRef: 'assets/skinned-bar.glb',
      nodeNameMap: { SkinnedBar: 'n_a', Bone0: 'n_b', Bone1: 'n_c' },
      childHierarchy: { SkinnedBar: ['Bone0'], Bone0: ['Bone1'] },
    });
    const value = GltfAssetNode.evaluate(params, {}) as GltfAssetValue;
    expect(value.childHierarchy).toEqual({ SkinnedBar: ['Bone0'], Bone0: ['Bone1'] });
  });

  it('pre-7.7 save (no childHierarchy) hydrates with an empty map — no throw', () => {
    // Exactly the shape a project saved before 7.7 carries: assetRef +
    // nodeNameMap only. The .default({}) must fill childHierarchy cleanly.
    const params = GltfAssetParams.parse({
      assetRef: 'assets/old.glb',
      nodeNameMap: { Cube: 'n_x' },
    });
    expect(params.childHierarchy).toEqual({});
    const value = GltfAssetNode.evaluate(params, {}) as GltfAssetValue;
    expect(value.childHierarchy).toEqual({});
  });

  it('a bare pre-7.5 save (assetRef only) still hydrates clean', () => {
    const params = GltfAssetParams.parse({ assetRef: 'assets/ancient.glb' });
    expect(params.nodeNameMap).toEqual({});
    expect(params.childHierarchy).toEqual({});
  });
});

describe('GltfAsset suppressedChildren (#151 W4 t9)', () => {
  it('threads suppressedChildren through evaluate into the value', () => {
    const params = GltfAssetParams.parse({
      assetRef: 'assets/textured.glb',
      suppressedChildren: ['Cube', 'Plane'],
    });
    const value = GltfAssetNode.evaluate(params, {}) as GltfAssetValue;
    expect(value.suppressedChildren).toEqual(['Cube', 'Plane']);
  });

  it('pre-151 save (no suppressedChildren) hydrates with an empty list — no throw', () => {
    // The shape a project saved before 151 carries: assetRef + the 7.x fields,
    // no suppression. The .default([]) must fill it cleanly (V10/H14 additive).
    const params = GltfAssetParams.parse({
      assetRef: 'assets/old.glb',
      nodeNameMap: { Cube: 'n_x' },
    });
    expect(params.suppressedChildren).toEqual([]);
    const value = GltfAssetNode.evaluate(params, {}) as GltfAssetValue;
    expect(value.suppressedChildren).toEqual([]);
  });
});
