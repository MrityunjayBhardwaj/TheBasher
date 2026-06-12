import { describe, it, expect } from 'vitest';
import { buildGltfDrillChain, type Obj3DLike } from './gltfDrillChain';
import type { DagState } from '../core/dag/state';

// Minimal fake DagState — the helper only reads nodes[id].type and
// params.nodeNameMap, plus node existence. Cast a partial.
function fakeState(): DagState {
  const node = (type: string, params: Record<string, unknown> = {}) =>
    ({ id: 'x', type, params }) as unknown;
  return {
    nodes: {
      n_asset: node('GltfAsset', {
        nodeNameMap: { body: 'n_body', wheel: 'n_wheel', bolt: 'n_bolt' },
      }),
      n_body: node('GltfChild', { childName: 'body' }),
      n_wheel: node('GltfChild', { childName: 'wheel' }),
      n_bolt: node('GltfChild', { childName: 'bolt' }),
    },
  } as unknown as DagState;
}

// build a leaf→root three.js parent chain by names
function chainOf(...names: string[]): Obj3DLike {
  let prev: Obj3DLike | null = null;
  // names given root→leaf; link so the LAST is the leaf with parents up to root
  for (const name of names) {
    const o: Obj3DLike = { name, parent: prev };
    prev = o;
  }
  return prev as Obj3DLike; // the leaf
}

describe('buildGltfDrillChain', () => {
  it('maps a deep hit to the full nested GltfChild chain (root→leaf)', () => {
    const state = fakeState();
    // wrapper(name=n_asset) > cloneRoot('') > body > wheel > bolt(hit)
    const hit = chainOf('n_asset', '', 'body', 'wheel', 'bolt');
    expect(buildGltfDrillChain(state, 'n_asset', hit)).toEqual([
      'n_asset',
      'n_body',
      'n_wheel',
      'n_bolt',
    ]);
  });

  it('uses topPickId as chain[0] when the asset is wrapped in a Group', () => {
    // glTF import nests the asset under a Group, so the top-level pick is the
    // Group id — the asset is found by hit-name match, not by topPickId.
    const state = fakeState();
    const hit = chainOf('n_grp', 'n_asset', '', 'body', 'wheel', 'bolt');
    expect(buildGltfDrillChain(state, 'n_grp', hit)).toEqual([
      'n_grp',
      'n_body',
      'n_wheel',
      'n_bolt',
    ]);
  });

  it('returns a single-level chain for a flat asset (asset → one child)', () => {
    const state = fakeState();
    const hit = chainOf('n_asset', '', 'body');
    expect(buildGltfDrillChain(state, 'n_asset', hit)).toEqual(['n_asset', 'n_body']);
  });

  it('skips intermediate objects with no GltfChild mapping', () => {
    const state = fakeState();
    // an un-named/unmapped group sits between wheel and bolt
    const hit = chainOf('n_asset', '', 'body', 'unmapped_grp', 'wheel', 'bolt');
    expect(buildGltfDrillChain(state, 'n_asset', hit)).toEqual([
      'n_asset',
      'n_body',
      'n_wheel',
      'n_bolt',
    ]);
  });

  it('returns null when there is no GltfAsset in the scene at all', () => {
    const state = { nodes: {} } as unknown as DagState;
    const hit = chainOf('body', 'bolt');
    expect(buildGltfDrillChain(state, 'n_top', hit)).toBeNull();
  });

  it('returns null when the hit maps to no GltfChild', () => {
    const state = fakeState();
    const hit = chainOf('n_asset', '', 'nothing_here');
    expect(buildGltfDrillChain(state, 'n_asset', hit)).toBeNull();
  });

  it('returns null for a null hit object', () => {
    expect(buildGltfDrillChain(fakeState(), 'n_asset', null)).toBeNull();
  });

  it('ignores map entries pointing at deleted nodes', () => {
    const state = fakeState();
    delete (state.nodes as Record<string, unknown>).n_wheel; // stale map entry
    const hit = chainOf('n_asset', '', 'body', 'wheel', 'bolt');
    // wheel is dropped; chain skips it
    expect(buildGltfDrillChain(state, 'n_asset', hit)).toEqual(['n_asset', 'n_body', 'n_bolt']);
  });
});
