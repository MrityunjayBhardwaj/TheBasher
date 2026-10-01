import { describe, it, expect } from 'vitest';
import { buildPickChain, type Obj3DLike } from './pickChain';
import type { DagState } from '../core/dag/state';

// Minimal fake DagState — the helper only reads node existence. Cast a partial.
function fakeState(): DagState {
  const node = (type: string, params: Record<string, unknown> = {}) =>
    ({ id: 'x', type, params }) as unknown;
  return {
    nodes: {
      // #1075 — native nodes: an import's Group → the file's empty → an Object
      n_grp: node('Group'),
      n_empty: node('Group'),
      n_obj: node('Object'),
      n_obj2: node('Object'),
    },
  } as unknown as DagState;
}

describe('buildPickChain', () => {
  it('returns null for a null hit object', () => {
    expect(buildPickChain(fakeState(), 'n_grp', null)).toBeNull();
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
});
