// #397 — Move to Collection, as Blender 5.1.1 does it (observed headless, `object.move_to_collection`):
// an object in the Scene Collection, A and B, moved to A, is in A alone; moved to the Scene
// Collection, it is in no collection; its child stays where it was; a move to a new collection makes
// that collection and puts the object in it alone.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { NodeId, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildAddPrimitiveOps } from './addPrimitives';
import {
  collectionsHolding,
  collectionMembersOf,
  hiddenByCollection,
  membershipOps,
  moveToCollectionOps,
  newCollectionOps,
  sceneCollectionsOf,
  sceneHeldNodes,
} from './collections';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

function addCollection(s: DagState): { state: DagState; id: NodeId } {
  const made = newCollectionOps(s)!;
  return { state: apply(s, made.ops), id: made.collectionId };
}

const add = (s: DagState, kind: Parameters<typeof buildAddPrimitiveOps>[1]) => {
  const r = buildAddPrimitiveOps(s, kind, [0, 0, 0])!;
  return { state: apply(s, r.ops), id: r.newNodeId };
};

/** A cube P in collections A and B, with a cube C parented under it and in neither. */
function scene() {
  let s = buildDefaultDagState();
  const a = addCollection(s);
  const b = addCollection(a.state);
  s = b.state;
  const p = add(s, 'Cube');
  const c = add(p.state, 'Cube');
  s = c.state;
  const sceneId = s.outputs.scene!.node;
  s = apply(s, [
    {
      type: 'disconnect',
      from: { node: c.id, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: c.id, socket: 'out' },
      to: { node: p.id, socket: 'children' },
    },
    ...membershipOps(a.id, [p.id]),
    ...membershipOps(b.id, [p.id]),
  ]);
  return { state: s, A: a.id, B: b.id, P: p.id, C: c.id };
}

const move = (s: DagState, ids: NodeId[], target: Parameters<typeof moveToCollectionOps>[2]) => {
  const r = moveToCollectionOps(s, ids, target)!;
  return { ...r, state: apply(s, r.ops) };
};

describe('#397 — Move to Collection', () => {
  it('the premise: P is in A and B, its child C in neither', () => {
    const { state, A, B, P, C } = scene();
    expect(collectionsHolding(state, P)).toEqual([A, B]);
    expect(collectionsHolding(state, C)).toEqual([]);
    expect(sceneHeldNodes(state).has(C)).toBe(true);
  });

  it('to A: P leaves B and stays in A alone; C is untouched', () => {
    const { state, A, P, C } = scene();
    const r = move(state, [P], { collectionId: A });
    expect(collectionsHolding(r.state, P)).toEqual([A]);
    expect(collectionsHolding(r.state, C)).toEqual([]);
    expect(r.moved).toEqual([P]);
  });

  it('to the Scene Collection: P leaves every collection', () => {
    const { state, P } = scene();
    const r = move(state, [P], { collectionId: null });
    expect(collectionsHolding(r.state, P)).toEqual([]);
    expect(r.collectionId).toBeNull();
  });

  it('a nested object moves alone, and its collection’s hide reaches it', () => {
    const { state, B, P, C } = scene();
    const r = move(state, [C], { collectionId: B });
    expect(collectionMembersOf(r.state, B)).toEqual([P, C]);
    expect(collectionsHolding(r.state, P).length).toBe(2);
    const hidden = apply(r.state, [{ type: 'setHidden', nodeId: B, hidden: true }]);
    expect(hiddenByCollection(hidden).has(C)).toBe(true);
  });

  it('to a new collection: it is made, named as New Collection names one, and holds P alone', () => {
    const { state, P } = scene();
    const before = sceneCollectionsOf(state);
    const r = move(state, [P], { newCollection: true });
    const made = sceneCollectionsOf(r.state).filter((id) => !before.includes(id));
    expect(made).toEqual([r.collectionId]);
    expect(r.state.nodes[made[0]].meta?.name).toBe('Collection.002');
    expect(collectionsHolding(r.state, P)).toEqual([made[0]]);
  });

  it('a light, a camera and the collection itself are skipped by name; the cube still moves', () => {
    const { state: s0, A, P } = scene();
    const light = add(s0, 'PointLight');
    const cam = add(light.state, 'PerspectiveCamera');
    const r = move(cam.state, [light.id, P, cam.id, A], { collectionId: A });
    expect(r.moved).toEqual([P]);
    expect(r.skipped).toEqual([light.id, cam.id, A]);
    expect(collectionMembersOf(r.state, A)).toEqual([P]);
  });

  it('moving to where it already is changes nothing', () => {
    const { state, A, P } = scene();
    const once = move(state, [P], { collectionId: A });
    expect(moveToCollectionOps(once.state, [P], { collectionId: A })!.ops).toEqual([]);
  });

  it('a target the scene does not hold is refused', () => {
    const { state, P } = scene();
    expect(moveToCollectionOps(state, [P], { collectionId: 'n_nope' })).toBeNull();
  });
});
