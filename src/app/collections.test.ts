// #1451 — Collections (#397), first slice: a named set of scene Objects, read off the graph. The
// outliner lists a collection with its members under it; a hidden collection hides its members
// in the viewport, bones included; and none of it is a transform — a member stands where it did.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { collectionOps } from '../core/import/modelImport';
import { buildSkeletonObjectOps } from '../core/import/skeletonObject';
import { registerAllNodes } from '../nodes/registerAll';
import { buildBvhClipOps } from '../test-utils/bvhClip';
import { collectionMembersOf, hiddenByCollection, sceneCollectionsOf } from './collections';
import { buildSceneTreeRows } from './sceneTreeWalk';
import { collectSkeletonObjects } from './skeletonObjects';
import { resolveWorldTransform } from './resolveWorldTransform';

const BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 1.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  End Site
  {
    OFFSET 0.0 0.5 0.0
  }
}
MOTION
Frames: 1
Frame Time: 0.0333333
0.0 1.0 0.0 0.0 0.0 0.0
`;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

/** The default project, a rig Object `sk_object` standing at x = 3, and a collection `col` holding it. */
function build({ hidden = false }: { hidden?: boolean } = {}): DagState {
  let s = buildDefaultDagState();
  const scene = s.outputs.scene!.node;
  s = apply(s, buildBvhClipOps({ text: BVH, ids: { skeleton: 'sk', clip: 'clip' } }).ops);
  s = apply(
    s,
    buildSkeletonObjectOps({
      skeletonId: 'sk',
      sceneNodeId: scene,
      name: 'rig',
      clipId: 'clip',
      nameFollowsClip: false,
    }).ops,
  );
  s = apply(s, [
    { type: 'setParam', nodeId: 'sk_object', paramPath: 'position', value: [3, 0, 0] },
  ]);
  s = apply(s, collectionOps('col', 'walk', ['sk_object'], scene));
  if (hidden) s = apply(s, [{ type: 'setHidden', nodeId: 'col', hidden: true }]);
  return s;
}

describe('#1451 — a Collection', () => {
  it('is held by the scene, named, and holds its members', () => {
    const s = build();
    expect(sceneCollectionsOf(s)).toEqual(['col']);
    expect(s.nodes.col.meta?.name).toBe('walk');
    expect(collectionMembersOf(s, 'col')).toEqual(['sk_object']);
  });

  it('is not a transform: its member stands where it did, still the scene’s child', () => {
    const s = build();
    const scene = s.outputs.scene!.node;
    expect(s.nodes[scene].inputs.children).toContainEqual({ node: 'sk_object', socket: 'out' });
    const world = resolveWorldTransform(s, 'sk_object', {
      time: { frame: 0, seconds: 0, normalized: 0 },
    } as never)!;
    expect(world.matrix.slice(12, 15)).toEqual([3, 0, 0]);
  });

  it('the outliner lists it with its member under it, and the member once', () => {
    const rows = buildSceneTreeRows(build());
    const at = (id: string) => rows.filter((r) => r.nodeId === id);
    expect(at('col')).toEqual([expect.objectContaining({ nodeType: 'Collection', depth: 1 })]);
    expect(at('sk_object')).toEqual([
      expect.objectContaining({
        depth: 2,
        parent: expect.objectContaining({ socket: 'children' }),
      }),
    ]);
    // Listed right under its collection.
    const i = rows.findIndex((r) => r.nodeId === 'col');
    expect(rows[i + 1].nodeId).toBe('sk_object');
  });

  it('hidden, it hides what it holds — the rig’s bones included — and visible, it hides nothing', () => {
    expect([...hiddenByCollection(build())]).toEqual([]);
    expect(collectSkeletonObjects(build()).map((o) => o.id)).toEqual(['sk_object']);
    expect([...hiddenByCollection(build({ hidden: true }))]).toEqual(['sk_object']);
    expect(collectSkeletonObjects(build({ hidden: true }))).toEqual([]);
  });
});
