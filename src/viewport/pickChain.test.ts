import { describe, it, expect } from 'vitest';
import { buildPickChain, type Obj3DLike } from './pickChain';
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
      // #1075 — native nodes: an import's Group → the file's empty → an Object
      n_grp: node('Group'),
      n_empty: node('Group'),
      n_obj: node('Object'),
      n_obj2: node('Object'),
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

// build a leaf→root chain from {name, id} links (root→leaf order). `id` becomes
// userData.basherGltfChildId — the H90 robust drill path. Names are deliberately
// set to values that DON'T appear in nodeNameMap, to prove the stamped path is
// immune to the producer-key ↔ clone-name divergence.
function stampedChainOf(...links: Array<{ name: string; id?: string }>): Obj3DLike {
  let prev: Obj3DLike | null = null;
  for (const { name, id } of links) {
    const o: Obj3DLike = { name, parent: prev, userData: id ? { basherGltfChildId: id } : {} };
    prev = o;
  }
  return prev as Obj3DLike;
}

describe('buildPickChain', () => {
  it('maps a deep hit to the full nested GltfChild chain (root→leaf)', () => {
    const state = fakeState();
    // wrapper(name=n_asset) > cloneRoot('') > body > wheel > bolt(hit)
    const hit = chainOf('n_asset', '', 'body', 'wheel', 'bolt');
    expect(buildPickChain(state, 'n_asset', hit)).toEqual([
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
    expect(buildPickChain(state, 'n_grp', hit)).toEqual(['n_grp', 'n_body', 'n_wheel', 'n_bolt']);
  });

  it('returns a single-level chain for a flat asset (asset → one child)', () => {
    const state = fakeState();
    const hit = chainOf('n_asset', '', 'body');
    expect(buildPickChain(state, 'n_asset', hit)).toEqual(['n_asset', 'n_body']);
  });

  it('skips intermediate objects with no GltfChild mapping', () => {
    const state = fakeState();
    // an un-named/unmapped group sits between wheel and bolt
    const hit = chainOf('n_asset', '', 'body', 'unmapped_grp', 'wheel', 'bolt');
    expect(buildPickChain(state, 'n_asset', hit)).toEqual([
      'n_asset',
      'n_body',
      'n_wheel',
      'n_bolt',
    ]);
  });

  it('returns null when there is no GltfAsset in the scene at all', () => {
    const state = { nodes: {} } as unknown as DagState;
    const hit = chainOf('body', 'bolt');
    expect(buildPickChain(state, 'n_top', hit)).toBeNull();
  });

  it('returns null when the hit maps to no GltfChild', () => {
    const state = fakeState();
    const hit = chainOf('n_asset', '', 'nothing_here');
    expect(buildPickChain(state, 'n_asset', hit)).toBeNull();
  });

  it('returns null for a null hit object', () => {
    expect(buildPickChain(fakeState(), 'n_asset', null)).toBeNull();
  });

  it('ignores map entries pointing at deleted nodes', () => {
    const state = fakeState();
    delete (state.nodes as Record<string, unknown>).n_wheel; // stale map entry
    const hit = chainOf('n_asset', '', 'body', 'wheel', 'bolt');
    // wheel is dropped; chain skips it
    expect(buildPickChain(state, 'n_asset', hit)).toEqual(['n_asset', 'n_body', 'n_bolt']);
  });

  // --- H90: stamped-id path (robust to glTF key↔name divergence) ---

  it('drills by stamped userData id even when clone NAMES diverge from nodeNameMap', () => {
    const state = fakeState();
    // The real-export case: clone names carry three.js dedup suffixes
    // (`body_0003`) that never match the producer keys (`body`), so name-match
    // would find NOTHING. The stamps point straight at the GltfChild ids.
    const hit = stampedChainOf(
      { name: 'n_grp' },
      { name: 'Scene' },
      { name: 'body_0003', id: 'n_body' },
      { name: 'wheel_0007', id: 'n_wheel' },
      { name: 'bolt_Mat_0_011', id: 'n_bolt' },
    );
    expect(buildPickChain(state, 'n_grp', hit)).toEqual(['n_grp', 'n_body', 'n_wheel', 'n_bolt']);
  });

  it('uses the nearest stamped ancestor for a material-split <unnamed> leaf', () => {
    const state = fakeState();
    // A glTF node with N primitives becomes N unnamed child meshes; only the
    // parent carries a name/stamp. The hit is the unnamed mesh → its nearest
    // stamped ancestor (the wheel) is the correct drill target.
    const hit = stampedChainOf(
      { name: 'n_grp' },
      { name: 'body_x', id: 'n_body' },
      { name: 'wheel_x', id: 'n_wheel' },
      { name: '' }, // unnamed material-split submesh (the actual hit) — no stamp
    );
    expect(buildPickChain(state, 'n_grp', hit)).toEqual(['n_grp', 'n_body', 'n_wheel']);
  });

  it('prefers the stamped path over name-match when both are present', () => {
    const state = fakeState();
    // Names happen to match `bolt`, but the stamp says `n_wheel` — the stamp wins
    // (it reflects the real node-index correspondence; the name could be a dup).
    const hit = stampedChainOf({ name: 'n_grp' }, { name: 'bolt', id: 'n_wheel' });
    expect(buildPickChain(state, 'n_grp', hit)).toEqual(['n_grp', 'n_wheel']);
  });

  it('skips a stamped id that points at a deleted node, keeping the rest', () => {
    const state = fakeState();
    delete (state.nodes as Record<string, unknown>).n_wheel;
    const hit = stampedChainOf(
      { name: 'n_grp' },
      { name: 'body_0', id: 'n_body' },
      { name: 'wheel_0', id: 'n_wheel' }, // stale
      { name: 'bolt_0', id: 'n_bolt' },
    );
    expect(buildPickChain(state, 'n_grp', hit)).toEqual(['n_grp', 'n_body', 'n_bolt']);
  });

  it('falls back to name-match when no ancestor is stamped (pre-UX#7 saves)', () => {
    const state = fakeState();
    // userData present but empty (hydrated old project) → stamped path yields
    // nothing → name-match fallback recovers the chain.
    const hit = stampedChainOf({ name: 'n_asset' }, { name: '' }, { name: 'body' });
    expect(buildPickChain(state, 'n_asset', hit)).toEqual(['n_asset', 'n_body']);
  });

  // --- #1075: drawn-node stamps (RenderChild), the native road ---

  // build a leaf→root chain from {name, node} links (root→leaf order). `node`
  // becomes userData.basherNodeId — what RenderChild writes on a nested node.
  function drawnChainOf(...links: Array<{ name?: string; node?: string }>): Obj3DLike {
    let prev: Obj3DLike | null = null;
    for (const { name = '', node } of links) {
      const o: Obj3DLike = { name, parent: prev, userData: node ? { basherNodeId: node } : {} };
      prev = o;
    }
    return prev as Obj3DLike;
  }

  it('maps a native import hit to the Object that drew it, not the Group', () => {
    // SceneChildNode wrapper (name = the Group id) > RenderChild(n_obj) > mesh(hit)
    const hit = drawnChainOf({ name: 'n_grp' }, { node: 'n_obj' }, {});
    expect(buildPickChain(fakeState(), 'n_grp', hit)).toEqual(['n_grp', 'n_obj']);
  });

  it('walks every nested drawn level: Group → the file empty → Object', () => {
    const hit = drawnChainOf({ name: 'n_grp' }, { node: 'n_empty' }, { node: 'n_obj' }, {});
    expect(buildPickChain(fakeState(), 'n_grp', hit)).toEqual(['n_grp', 'n_empty', 'n_obj']);
  });

  it('never repeats the top-level id when it is also stamped', () => {
    const hit = drawnChainOf({ name: 'n_grp', node: 'n_grp' }, { node: 'n_obj' }, {});
    expect(buildPickChain(fakeState(), 'n_grp', hit)).toEqual(['n_grp', 'n_obj']);
  });

  it('skips a drawn stamp for a deleted node', () => {
    const state = fakeState();
    delete (state.nodes as Record<string, unknown>).n_empty;
    const hit = drawnChainOf({ name: 'n_grp' }, { node: 'n_empty' }, { node: 'n_obj' }, {});
    expect(buildPickChain(state, 'n_grp', hit)).toEqual(['n_grp', 'n_obj']);
  });

  it('a top-level mesh with no nested drawn node has no chain', () => {
    const hit = drawnChainOf({ name: 'n_obj2' }, {});
    expect(buildPickChain(fakeState(), 'n_obj2', hit)).toBeNull();
  });

  it('the clone road is unchanged: its drawn GltfAsset is not a level, and the name fallback still runs', () => {
    // n_grp wrapper > RenderChild(n_asset) > clone root '' > body(hit), no clone stamps.
    // Were the asset's drawn stamp taken, the chain would be [n_grp, n_asset] and the
    // fallback would never run.
    const hit = drawnChainOf(
      { name: 'n_grp' },
      { node: 'n_asset' },
      { name: '' },
      { name: 'body' },
    );
    expect(buildPickChain(fakeState(), 'n_grp', hit)).toEqual(['n_grp', 'n_body']);
  });

  it('a clone inside a drawn Group still name-matches its children below that Group', () => {
    // user Group (top) > RenderChild(n_empty) > RenderChild(n_asset) > '' > body, no clone
    // stamps. The drawn level above must not stop the clone's fallback from running.
    const hit = drawnChainOf(
      { name: 'n_grp' },
      { node: 'n_empty' },
      { node: 'n_asset' },
      { name: '' },
      { name: 'body' },
    );
    expect(buildPickChain(fakeState(), 'n_grp', hit)).toEqual(['n_grp', 'n_empty', 'n_body']);
  });

  it('the clone road is unchanged with stamps: [Group, …GltfChildren]', () => {
    const o = (name: string, parent: Obj3DLike | null, userData: Obj3DLike['userData']) =>
      ({ name, parent, userData }) as Obj3DLike;
    const top = o('n_grp', null, {});
    const asset = o('', top, { basherNodeId: 'n_asset' });
    const body = o('body_1', asset, { basherGltfChildId: 'n_body' });
    const bolt = o('bolt_1', body, { basherGltfChildId: 'n_bolt' });
    expect(buildPickChain(fakeState(), 'n_grp', bolt)).toEqual(['n_grp', 'n_body', 'n_bolt']);
  });
});
