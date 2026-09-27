// #1056 — every imported motion gets an Object of its own. These rows pin the ops, the
// socket that admits the skeleton, and that the Object never sizes the rig (#1086).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../dag';
import type { DagState } from '../dag/state';
import type { Op } from '../dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import type { AnimationClipValue, BoneSpec, ObjectValue } from '../../nodes/types';
import { boneTransforms } from '../../viewport/boneShape';
import { armatureBounds, posedSourceBones } from '../../viewport/referenceRig';
import { buildBvhImportOps } from './bvhImportChain';
import {
  buildSkeletonObjectOps,
  skeletonObjectId,
  standInObjectOf,
  standingObjectsOf,
} from './skeletonObject';

const BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 90.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT Spine
  {
    OFFSET 0.0 40.0 0.0
    CHANNELS 3 Xrotation Yrotation Zrotation
    JOINT Head
    {
      OFFSET 0.0 30.0 0.0
      CHANNELS 3 Xrotation Yrotation Zrotation
      End Site
      {
        OFFSET 0.0 10.0 0.0
      }
    }
  }
}
MOTION
Frames: 1
Frame Time: 0.0333333
0.0 90.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0
`;

function sceneState(): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  return { ...s, outputs: { scene: { node: 'scene', socket: 'out' } } };
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('buildSkeletonObjectOps', () => {
  it('adds an Object, points its data at the skeleton, and makes it a scene child', () => {
    const { ops, objectId } = buildSkeletonObjectOps({
      skeletonId: 'sk',
      sceneNodeId: 'scene',
      name: 'soma-walk',
      clipId: 'clip',
    });
    expect(objectId).toBe(skeletonObjectId('sk'));
    expect(ops).toEqual([
      {
        type: 'addNode',
        nodeId: objectId,
        nodeType: 'Object',
        params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      { type: 'setMeta', nodeId: objectId, name: 'soma-walk', nameFrom: 'clip' },
      {
        type: 'connect',
        from: { node: 'sk', socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: objectId, socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      },
    ]);
  });

  it('applied after a BVH import, the Object evaluates to the skeleton as its data', () => {
    let state = sceneState();
    const imported = buildBvhImportOps({ text: BVH, ids: { skeleton: 'sk', clip: 'clip' } });
    for (const op of imported.ops) state = applyOp(state, op).next;
    const bones = (state.nodes.sk.params as { bones: BoneSpec[] }).bones;
    const { ops, objectId } = buildSkeletonObjectOps({
      skeletonId: 'sk',
      sceneNodeId: 'scene',
      name: 'sk',
      clipId: 'clip',
    });
    for (const op of ops) state = applyOp(state, op).next;

    const value = evaluate(state, objectId, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as ObjectValue;
    expect(value.kind).toBe('Object');
    expect(value.data?.kind).toBe('Skeleton');
    expect(value.data && 'bones' in value.data ? value.data.bones.length : 0).toBe(bones.length);
    expect(state.nodes.scene.inputs.children).toEqual([{ node: objectId, socket: 'out' }]);
  });

  // POSITIVE CONTROL for the row above: the data socket still refuses what it did before. If
  // the accept set had been widened to "anything", the skeleton row would pass for the wrong
  // reason.
  it('the data socket still refuses an output that is neither ObjectData nor Skeleton', () => {
    let state = sceneState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 't',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    state = applyOp(state, { type: 'addNode', nodeId: 'o', nodeType: 'Object', params: {} }).next;
    expect(() =>
      applyOp(state, {
        type: 'connect',
        from: { node: 't', socket: 'out' },
        to: { node: 'o', socket: 'data' },
      }),
    ).toThrow(/type mismatch/);
  });
});

// #1086 — the Object never sizes the rig. A format that declares its unit is read in it at parse,
// and one that declares none stands at the file's own size (#791). This is the absolute row on
// the real file: `soma-walk.bvh` is authored in centimetres and its frame 0 stands ~161 units
// tall, so a scale that is not 1 — the old fit stood it at 1.8 m — reds here.
describe('#1086 — the Object stands the rig at the size its data says', () => {
  it("the real soma-walk.bvh stands at scale 1 and draws at the file's own height", () => {
    let state = sceneState();
    const text = readFileSync(resolve(process.cwd(), 'public/fixtures/anim/soma-walk.bvh'), 'utf8');
    const imported = buildBvhImportOps({ text, ids: { skeleton: 'sk', clip: 'clip' } });
    for (const op of imported.ops) state = applyOp(state, op).next;
    const clip = evaluate(state, 'clip', {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as AnimationClipValue;
    expect(clip.kind).toBe('AnimationClip');

    const { ops } = buildSkeletonObjectOps({
      skeletonId: 'sk',
      sceneNodeId: 'scene',
      name: 'soma-walk',
      clipId: 'clip',
    });
    expect(ops[0]).toMatchObject({ params: { scale: [1, 1, 1] } });
    const drawn = armatureBounds(boneTransforms(posedSourceBones(clip, 0))).height;
    expect(drawn).toBeGreaterThan(100);
    expect(drawn).toBeLessThan(250);
  });
});

describe('#1101 — the Object carries its motion name', () => {
  it('applied, the name is the one the outliner reads; a blank name adds no op', () => {
    let state = sceneState();
    // Named as the import road names it: the clip after the file, and the Object after its clip.
    const imported = buildBvhImportOps({
      text: BVH,
      name: 'soma-walk',
      ids: { skeleton: 'sk', clip: 'clip' },
    });
    for (const op of imported.ops) state = applyOp(state, op).next;
    const named = buildSkeletonObjectOps({
      skeletonId: 'sk',
      sceneNodeId: 'scene',
      name: 'soma-walk',
      clipId: 'clip',
    });
    for (const op of named.ops) state = applyOp(state, op).next;
    expect(state.nodes[named.objectId].meta?.name).toBe('soma-walk');

    const blank = buildSkeletonObjectOps({
      skeletonId: 'sk2',
      sceneNodeId: 'scene',
      name: '   ',
      clipId: 'clip',
    });
    expect(blank.ops.some((op) => op.type === 'setMeta')).toBe(false);
  });
});

describe('standingObjectsOf (#1100)', () => {
  it('finds every Object whose data is the skeleton, id-sorted, and no other Object', () => {
    let state = sceneState();
    const imported = buildBvhImportOps({ text: BVH, ids: { skeleton: 'sk', clip: 'clip' } });
    for (const op of imported.ops) state = applyOp(state, op).next;
    const ops: Op[] = [
      // Pointed at the skeleton by hand — found by its edge, not by the importer's id.
      { type: 'addNode', nodeId: 'z_by_hand', nodeType: 'Object', params: {} },
      {
        type: 'connect',
        from: { node: 'sk', socket: 'out' },
        to: { node: 'z_by_hand', socket: 'data' },
      },
      // An Empty that sorts FIRST, so a lookup that forgot the edge check would return it.
      { type: 'addNode', nodeId: 'a_empty', nodeType: 'Object', params: {} },
      ...buildSkeletonObjectOps({
        skeletonId: 'sk',
        sceneNodeId: 'scene',
        name: 'sk',
        clipId: 'clip',
      }).ops,
    ];
    for (const op of ops) state = applyOp(state, op).next;
    expect(standingObjectsOf(state, 'sk')).toEqual([skeletonObjectId('sk'), 'z_by_hand']);
    expect(standingObjectsOf(state, 'clip')).toEqual([]);
  });
});

describe('standInObjectOf (#1088)', () => {
  /** A skeleton `sk`, a second skeleton `other`, and an Object with `objectId` on `dataFrom`. */
  function withObject(objectId: string, dataFrom: string): DagState {
    let state = sceneState();
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'sk', nodeType: 'Skeleton', params: { bones: [] } },
      { type: 'addNode', nodeId: 'other', nodeType: 'Skeleton', params: { bones: [] } },
      { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: {} },
      {
        type: 'connect',
        from: { node: dataFrom, socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
    ];
    for (const op of ops) state = applyOp(state, op).next;
    return state;
  }

  it("names the import's Object while it shows the skeleton", () => {
    expect(standInObjectOf(withObject(skeletonObjectId('sk'), 'sk'), 'sk')).toBe('sk_object');
  });

  it('names no Object the director pointed at the skeleton', () => {
    const state = withObject('a_by_hand', 'sk');
    expect(standingObjectsOf(state, 'sk')).toEqual(['a_by_hand']);
    expect(standInObjectOf(state, 'sk')).toBeNull();
  });

  it("names nothing once the import's Object is pointed at another skeleton", () => {
    const state = withObject(skeletonObjectId('sk'), 'other');
    expect(standInObjectOf(state, 'sk')).toBeNull();
    expect(standInObjectOf(state, 'other')).toBeNull();
  });
});
