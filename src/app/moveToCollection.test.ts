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
  hiddenNodes,
  membershipOps,
  moveToCollectionOps,
  newCollectionOps,
  sceneCollectionsOf,
  collectableNodes,
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
    expect(collectableNodes(state).has(C)).toBe(true);
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
    const hidden = apply(r.state, [
      { type: 'setParam', nodeId: B, paramPath: 'viewport', value: false },
    ]);
    expect(hiddenByCollection(hidden, 'viewport').has(C)).toBe(true);
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

  it('a light and a camera move like any object (#1453); the collection itself is skipped', () => {
    const { state: s0, A, P } = scene();
    const light = add(s0, 'PointLight');
    const cam = add(light.state, 'PerspectiveCamera');
    const r = move(cam.state, [light.id, P, cam.id, A], { collectionId: A });
    expect(r.moved).toEqual([light.id, P, cam.id]);
    expect(r.skipped).toEqual([A]);
    expect(collectionMembersOf(r.state, A)).toEqual([P, light.id, cam.id]);
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

describe('#1462 — a hidden node is hidden alone', () => {
  it('its own eye or its collections hide it, and never the child under it', () => {
    const { state, A, B, P, C } = scene();
    expect([...hiddenNodes(state, 'viewport')]).toEqual([]);
    const byEye = apply(state, [
      { type: 'setParam', nodeId: P, paramPath: 'viewport', value: false },
    ]);
    expect([...hiddenNodes(byEye, 'viewport')]).toEqual([P]);
    const byCollections = apply(state, [
      { type: 'setParam', nodeId: A, paramPath: 'viewport', value: false },
      { type: 'setParam', nodeId: B, paramPath: 'viewport', value: false },
    ]);
    expect(hiddenNodes(byCollections, 'viewport').has(P)).toBe(true);
    expect(hiddenNodes(byCollections, 'viewport').has(C)).toBe(false);
  });
});

describe('#1481 — a node in several collections hides only when every one of them is hidden', () => {
  // Blender 5.1.1 (headless, 2026-10-04): O in collections A and B stays visible with A hidden
  // (`visible_get`, and in the depsgraph), and hides with A and B — for the viewport toggle and
  // the render toggle alike (Cycles: pixel mean 0.772 with A off, 0.0 with A and B).
  it('P in A and B: A hidden alone keeps P; A and B hide it; its own eye hides it regardless', () => {
    const { state, A, B, P, C } = scene();
    const onlyA = apply(state, [
      { type: 'setParam', nodeId: A, paramPath: 'viewport', value: false },
    ]);
    expect(hiddenByCollection(onlyA, 'viewport').has(P)).toBe(false);
    expect(hiddenNodes(onlyA, 'viewport').has(P)).toBe(false);
    const onlyB = apply(state, [
      { type: 'setParam', nodeId: B, paramPath: 'viewport', value: false },
    ]);
    expect(hiddenNodes(onlyB, 'viewport').has(P)).toBe(false);
    const both = apply(onlyA, [
      { type: 'setParam', nodeId: B, paramPath: 'viewport', value: false },
    ]);
    expect(hiddenByCollection(both, 'viewport').has(P)).toBe(true);
    const eye = apply(state, [
      { type: 'setParam', nodeId: P, paramPath: 'viewport', value: false },
    ]);
    expect(hiddenNodes(eye, 'viewport').has(P)).toBe(true);
    for (const s of [onlyA, onlyB, both, eye])
      expect(hiddenNodes(s, 'viewport').has(C)).toBe(false);
  });

  it('a node in one collection still hides with it', () => {
    const { state, B, C } = scene();
    const moved = moveToCollectionOps(state, [C], { collectionId: B })!;
    const s = apply(apply(state, moved.ops), [
      { type: 'setParam', nodeId: B, paramPath: 'viewport', value: false },
    ]);
    expect(collectionsHolding(s, C)).toEqual([B]);
    expect(hiddenNodes(s, 'viewport').has(C)).toBe(true);
  });
});
