// nodesReferencingImport — unit coverage, Phase 7.14 Wave B (B1).

import { describe, expect, it } from 'vitest';
import type { DagState } from '../../core/dag/state';
import type { Node } from '../../core/dag/types';
import { importPathPrefix, nodesReferencingImport } from './importRefs';

function gltfAsset(id: string, assetRef: string): Node {
  return { id, type: 'GltfAsset', version: 1, params: { assetRef }, inputs: {} };
}

function stateOf(...nodes: Node[]): DagState {
  const map: Record<string, Node> = {};
  for (const n of nodes) map[n.id] = n;
  return { nodes: map, outputs: {} };
}

describe('importPathPrefix', () => {
  it('is the user-imports/<name>/ prefix with a trailing slash', () => {
    expect(importPathPrefix('walk')).toBe('user-imports/walk/');
  });
});

describe('nodesReferencingImport', () => {
  it('returns GltfAsset ids whose assetRef is under the import dir', () => {
    const state = stateOf(
      gltfAsset('a', 'user-imports/cube/cube.glb'),
      gltfAsset('b', 'user-imports/cube/cube.glb'),
      gltfAsset('c', 'user-imports/other/scene.gltf'),
    );
    expect(nodesReferencingImport('cube', state).sort()).toEqual(['a', 'b']);
  });

  it('returns [] when nothing references the import', () => {
    const state = stateOf(gltfAsset('a', 'user-imports/other/scene.gltf'));
    expect(nodesReferencingImport('cube', state)).toEqual([]);
  });

  it('respects the prefix boundary: import "foo" does not match "foobar"', () => {
    const state = stateOf(
      gltfAsset('a', 'user-imports/foo/scene.gltf'),
      gltfAsset('b', 'user-imports/foobar/scene.gltf'),
    );
    expect(nodesReferencingImport('foo', state)).toEqual(['a']);
    expect(nodesReferencingImport('foobar', state)).toEqual(['b']);
  });

  it('ignores non-GltfAsset nodes and nodes without a string assetRef', () => {
    const state = stateOf(
      { id: 'sk', type: 'Skeleton', version: 1, params: { bones: [] }, inputs: {} },
      { id: 'clip', type: 'AnimationClip', version: 1, params: {}, inputs: {} },
      // A GltfAsset with a non-import assetRef (sample asset) — not a match.
      gltfAsset('g', 'assets/sample.glb'),
    );
    expect(nodesReferencingImport('walk', state)).toEqual([]);
  });

  it('matches nested-entry assetRefs (e.g. user-imports/<name>/gltf/scene.gltf)', () => {
    const state = stateOf(gltfAsset('a', 'user-imports/nested/gltf/scene.gltf'));
    expect(nodesReferencingImport('nested', state)).toEqual(['a']);
  });
});
