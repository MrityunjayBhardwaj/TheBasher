// #397 — nested collections, as Blender 5.1.1 has them (measured headless, 2026-10-05): a collection
// nests in another and may sit in several; a cycle is refused; an object shows while one path from
// the scene down to it is shown all the way; a new object lands in a nested active collection; and
// Delete hands a collection's objects and nested collections to every collection it sat in
// (`BKE_collection_delete`, `hierarchy == false`).
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { NodeId, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { composeProject, loadProject, saveProject } from '../core/project/io';
import { MemoryStorage } from '../core/storage';
import { registerAllNodes } from '../nodes/registerAll';
import { buildAddPrimitiveOps } from './addPrimitives';
import {
  activeCollectionOf,
  allCollectionsOf,
  childCollectionsOf,
  collectionMembersOf,
  collectionTreeOf,
  collectionsHolding,
  hiddenNodes,
  moveToCollectionOps,
  newCollectionOps,
  sceneCollectionsOf,
  setActiveCollectionOp,
  type VisibilityPurpose,
} from './collections';
import { buildDeleteNodesOps } from './sceneNodeActions';
import { buildSceneTreeRows } from './sceneTreeWalk';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

const nest = (child: NodeId, parent: NodeId): Op => ({
  type: 'connect',
  from: { node: child, socket: 'out' },
  to: { node: parent, socket: 'collections' },
});

const off = (id: NodeId, purpose: VisibilityPurpose = 'viewport'): Op => ({
  type: 'setParam',
  nodeId: id,
  paramPath: purpose,
  value: false,
});

function newCollection(s: DagState, parent: NodeId | null = null) {
  const made = newCollectionOps(s, parent)!;
  return { state: apply(s, made.ops), id: made.collectionId };
}

/**
 * Top collections P and Q; C nested in P (and in Q too with `alsoInQ`); a cube O in C; D nested
 * in C. The cube is added with C active, so it lands there as Blender's add does.
 */
function build({ alsoInQ = false } = {}) {
  let s = buildDefaultDagState();
  const p = newCollection(s);
  const q = newCollection(p.state);
  const c = newCollection(q.state, p.id);
  const d = newCollection(c.state, c.id);
  s = d.state;
  if (alsoInQ) s = apply(s, [nest(c.id, q.id)]);
  s = apply(s, [setActiveCollectionOp(s, c.id)!]);
  const added = buildAddPrimitiveOps(s, 'Cube', [0, 0, 0])!;
  s = apply(s, added.ops);
  return { s, P: p.id, Q: q.id, C: c.id, D: d.id, O: added.newNodeId };
}

describe('#397 — nested collections', () => {
  it('the premise: New Collection with a parent nests in it; the scene holds only the top ones', () => {
    const { s, P, Q, C, D, O } = build();
    expect(sceneCollectionsOf(s)).toEqual([P, Q]);
    expect(childCollectionsOf(s, P)).toEqual([C]);
    expect(childCollectionsOf(s, C)).toEqual([D]);
    expect(allCollectionsOf(s)).toEqual([P, C, D, Q]);
    // A nested active collection is honoured, and Add lands in it (Blender: "cube lands in ['C']").
    expect(activeCollectionOf(s)).toBe(C);
    expect(collectionsHolding(s, O)).toEqual([C]);
  });

  it('names a new collection past every name in the tree, nested ones too', () => {
    const { s } = build();
    const names = allCollectionsOf(s).map((id) => s.nodes[id].meta?.name);
    expect(names).toEqual(['Collection', 'Collection.002', 'Collection.003', 'Collection.001']);
    const e = newCollection(s);
    expect(e.state.nodes[e.id].meta?.name).toBe('Collection.004');
  });

  it('a parent that is not one of the scene’s collections leaves the new one in the scene', () => {
    const { s, O } = build();
    const e = newCollection(s, O);
    expect(sceneCollectionsOf(e.state)).toContain(e.id);
  });

  it('one collection in two parents is listed at both places', () => {
    const { s, P, Q, C, D } = build({ alsoInQ: true });
    expect(collectionTreeOf(s)).toEqual([
      { id: P, depth: 0, parent: null },
      { id: C, depth: 1, parent: P },
      { id: D, depth: 2, parent: C },
      { id: Q, depth: 0, parent: null },
      { id: C, depth: 1, parent: Q },
      { id: D, depth: 2, parent: C },
    ]);
    expect(allCollectionsOf(s)).toEqual([P, C, D, Q]);
  });

  it('a save keeps the nesting, and the load reads the same tree', async () => {
    const { s } = build({ alsoInQ: true });
    expect(collectionTreeOf(s)).toHaveLength(6);
    const storage = new MemoryStorage();
    await saveProject(storage, composeProject({ id: 'p', name: 'nested', state: s }));
    const loaded = await loadProject(storage, 'p');
    const back = { ...s, nodes: loaded.state.nodes, outputs: loaded.state.outputs } as DagState;
    expect(collectionTreeOf(back)).toEqual(collectionTreeOf(s));
  });

  it('a cycle is refused, as Blender refuses one', () => {
    const { s, P, C, D } = build();
    expect(() => apply(s, [nest(P, D)])).toThrow(/cycle/);
    expect(() => apply(s, [nest(C, C)])).toThrow(/cycle/);
  });

  for (const purpose of ['viewport', 'render'] as const) {
    describe(`hiding (${purpose})`, () => {
      it('a hidden parent hides what its nested collection holds, the nested one itself on', () => {
        const { s, P, O } = build();
        expect(hiddenNodes(s, purpose).has(O)).toBe(false);
        expect(hiddenNodes(apply(s, [off(P, purpose)]), purpose).has(O)).toBe(true);
      });

      it('in two parents, it stays while one path is shown and hides with both off', () => {
        const { s, P, Q, O } = build({ alsoInQ: true });
        expect(hiddenNodes(apply(s, [off(P, purpose)]), purpose).has(O)).toBe(false);
        expect(hiddenNodes(apply(s, [off(Q, purpose)]), purpose).has(O)).toBe(false);
        expect(hiddenNodes(apply(s, [off(P, purpose), off(Q, purpose)]), purpose).has(O)).toBe(
          true,
        );
      });

      it('an object also in a shown collection stays, its nested one hidden by the parent', () => {
        const { s, P, Q, O } = build();
        const both = apply(s, [
          { type: 'connect', from: { node: O, socket: 'out' }, to: { node: Q, socket: 'members' } },
          off(P, purpose),
        ]);
        expect(hiddenNodes(both, purpose).has(O)).toBe(false);
      });
    });
  }

  it('the purposes stay apart: a parent off for the viewport only leaves the render shown', () => {
    const { s, P, O } = build();
    const t = apply(s, [off(P, 'viewport')]);
    expect(hiddenNodes(t, 'viewport').has(O)).toBe(true);
    expect(hiddenNodes(t, 'render').has(O)).toBe(false);
  });

  it('Move to Collection reaches a nested collection, and leaves the nested one it was in', () => {
    const { s, D, O } = build();
    const moved = moveToCollectionOps(s, [O], { collectionId: D })!;
    expect(moved.collectionId).toBe(D);
    expect(collectionsHolding(apply(s, moved.ops), O)).toEqual([D]);
  });

  it('the outliner lists a nested collection under its parent, then its members, at each place', () => {
    const { s, P, Q, C, D, O } = build({ alsoInQ: true });
    const rows = buildSceneTreeRows(s).map((r) => [r.nodeId, r.depth]);
    const at = (id: NodeId) => rows.filter(([n]) => n === id).map(([, depth]) => depth);
    expect(at(P)).toEqual([1]);
    expect(at(Q)).toEqual([1]);
    expect(at(C)).toEqual([2, 2]);
    expect(at(D)).toEqual([3, 3]);
    // A member is listed once — under the first collection holding it — at its depth there.
    expect(at(O)).toEqual([3]);
    const order = rows.map(([n]) => n);
    expect(order.indexOf(D)).toBeLessThan(order.indexOf(O));
    expect(order.indexOf(O)).toBeLessThan(order.indexOf(Q));
  });

  describe('Delete hands on what a collection held', () => {
    it('a nested one hands its objects and nested collections to its parent', () => {
      const { s, P, C, D, O } = build();
      const t = apply(s, buildDeleteNodesOps(s, [C]));
      expect(t.nodes[C]).toBeUndefined();
      expect(t.nodes[O]).toBeDefined();
      expect(t.nodes[D]).toBeDefined();
      expect(collectionMembersOf(t, P)).toEqual([O]);
      expect(childCollectionsOf(t, P)).toEqual([D]);
    });

    it('one in two parents hands them to both', () => {
      const { s, P, Q, C, D, O } = build({ alsoInQ: true });
      const t = apply(s, buildDeleteNodesOps(s, [C]));
      expect(collectionsHolding(t, O)).toEqual([P, Q]);
      expect(childCollectionsOf(t, P)).toEqual([D]);
      expect(childCollectionsOf(t, Q)).toEqual([D]);
    });

    it('a top one hands its nested collections to the scene, and its objects to no collection', () => {
      const { s, P, Q, C } = build();
      const withMember = apply(s, buildDeleteNodesOps(s, [P]));
      expect(sceneCollectionsOf(withMember)).toEqual([Q, C]);
    });

    it('deleting a parent with its child passes the grandchild and the objects up past both', () => {
      const { s, Q, C, D, O, P } = build();
      const t = apply(s, buildDeleteNodesOps(s, [P, C]));
      expect(sceneCollectionsOf(t)).toEqual([Q, D]);
      expect(collectionsHolding(t, O)).toEqual([]);
      expect(t.nodes[O]).toBeDefined();
    });

    it('what is deleted alongside it is not handed on', () => {
      const { s, P, C, D } = build();
      const t = apply(s, buildDeleteNodesOps(s, [C, D]));
      expect(childCollectionsOf(t, P)).toEqual([]);
    });
  });
});
