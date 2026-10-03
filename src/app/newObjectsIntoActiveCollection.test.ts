// #1453 — every object that stands in the scene joins the active collection, not only an import's.
// Blender 5.1.1 (headless, observed): with a collection active, `primitive_cube_add` lands in it and
// `object.duplicate` lands in its source's collections; with the scene collection active, an added
// object joins none. Lights and cameras stay out until their drawers honour a hidden collection.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildAddPrimitiveOps } from './addPrimitives';
import { mintMotionGenerateOps } from './asset/mintMotionGenerate';
import {
  collectionMembersOf,
  hiddenByCollection,
  newCollectionOps,
  setActiveCollectionOp,
} from './collections';
import { buildDuplicateNodeOps } from './sceneNodeActions';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

/** The default project with one new collection; `active` makes it the active one. */
function withCollection(active: boolean): { state: DagState; col: string } {
  let s = buildDefaultDagState();
  const made = newCollectionOps(s)!;
  s = apply(s, made.ops);
  if (active) s = apply(s, [setActiveCollectionOp(s, made.collectionId)!]);
  return { state: s, col: made.collectionId };
}

const add = (s: DagState, kind: Parameters<typeof buildAddPrimitiveOps>[1]) => {
  const r = buildAddPrimitiveOps(s, kind, [0, 0, 0])!;
  return { state: apply(s, r.ops), id: r.newNodeId };
};

describe('#1453 — Add links into the active collection', () => {
  it.each(['Cube', 'Sphere', 'Curve', 'Null'] as const)(
    'a %s added with a collection active is its member, and its hide hides it',
    (kind) => {
      const { state, col } = withCollection(true);
      const { state: s, id } = add(state, kind);
      expect(collectionMembersOf(s, col)).toEqual([id]);
      const hidden = apply(s, [{ type: 'setHidden', nodeId: col, hidden: true }]);
      expect(hiddenByCollection(hidden).has(id)).toBe(true);
    },
  );

  it('with the scene itself active, an added cube joins no collection', () => {
    const { state, col } = withCollection(false);
    const { state: s } = add(state, 'Cube');
    expect(collectionMembersOf(s, col)).toEqual([]);
  });

  it.each(['PointLight', 'PerspectiveCamera'] as const)(
    'a %s stays out: its drawer honours no hidden collection yet',
    (kind) => {
      const { state, col } = withCollection(true);
      const { state: s } = add(state, kind);
      expect(collectionMembersOf(s, col)).toEqual([]);
    },
  );
});

describe('#1453 — generated motion links its rig Object into the active collection', () => {
  const ARGS = { prompt: 'a walk', seed: 1, model: 'kimodo' };
  it('active collection → the rig Object is a member; none active → it is in none', () => {
    for (const active of [true, false]) {
      const { state, col } = withCollection(active);
      const minted = mintMotionGenerateOps(state, ARGS);
      const s = apply(state, minted.ops);
      expect(minted.objectId).toBeDefined();
      expect(collectionMembersOf(s, col)).toEqual(active ? [minted.objectId] : []);
    }
  });
});

describe('#1453 — a duplicate joins its source’s collections', () => {
  it('the copy of a member is a member of the same collection; the copy of a non-member is not', () => {
    const { state, col } = withCollection(true);
    const { state: s1, id: member } = add(state, 'Cube');
    const s2 = apply(s1, [setActiveCollectionOp(s1, null)!]);
    const { state: s3, id: loose } = add(s2, 'Cube');
    expect(collectionMembersOf(s3, col)).toEqual([member]);

    const dupMember = buildDuplicateNodeOps(s3, member)!;
    const s4 = apply(s3, dupMember.ops);
    expect(collectionMembersOf(s4, col)).toEqual([member, dupMember.newRootId]);

    const dupLoose = buildDuplicateNodeOps(s4, loose)!;
    const s5 = apply(s4, dupLoose.ops);
    expect(collectionMembersOf(s5, col)).toEqual([member, dupMember.newRootId]);
  });
});
