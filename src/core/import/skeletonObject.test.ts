// #1056 — a motion nothing binds gets an Object of its own. These rows pin the ops, the
// socket that admits the skeleton, and the scale that stands an unknown-unit rig up.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../dag';
import type { DagState } from '../dag/state';
import { registerAllNodes } from '../../nodes/registerAll';
import type { BoneSpec, ObjectValue } from '../../nodes/types';
import { boneTransforms } from '../../viewport/boneShape';
import { armatureBounds } from '../../viewport/referenceRig';
import { buildBvhImportOps } from './bvhImportChain';
import {
  UNBOUND_RIG_HEIGHT_METRES,
  buildSkeletonObjectOps,
  normalisedRigScale,
  skeletonObjectId,
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

const RIG: BoneSpec[] = [
  { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'spine', parent: 0, position: [0, 2, 0], rotation: [0, 0, 0] },
  { name: 'neck', parent: 1, position: [0, 2, 0], rotation: [0, 0, 0] },
  { name: 'head', parent: 2, position: [0, 1, 0], rotation: [0, 0, 0] },
];

const scaled = (bones: BoneSpec[], k: number): BoneSpec[] =>
  bones.map((b) => ({ ...b, position: [b.position[0] * k, b.position[1] * k, b.position[2] * k] }));

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
      bones: RIG,
      sceneNodeId: 'scene',
      normalise: false,
    });
    expect(objectId).toBe(skeletonObjectId('sk'));
    expect(ops).toEqual([
      {
        type: 'addNode',
        nodeId: objectId,
        nodeType: 'Object',
        params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
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
      bones,
      sceneNodeId: 'scene',
      normalise: true,
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

describe('normalisedRigScale', () => {
  it('stands the rest pose at the unbound rig height', () => {
    const s = normalisedRigScale(RIG);
    const height = armatureBounds(boneTransforms(scaled(RIG, s))).height;
    expect(height).toBeCloseTo(UNBOUND_RIG_HEIGHT_METRES, 6);
  });

  it('is unit-invariant: the same rig authored 100× larger gets a 100× smaller scale', () => {
    expect(normalisedRigScale(scaled(RIG, 100))).toBeCloseTo(normalisedRigScale(RIG) / 100, 9);
  });

  it('ignores where the transport root stands — moving it does not change the size', () => {
    const moved = RIG.map((b, i) =>
      i === 0 ? { ...b, position: [3, 50, -7] as BoneSpec['position'] } : b,
    );
    expect(normalisedRigScale(moved)).toBeCloseTo(normalisedRigScale(RIG), 9);
  });

  it('a rig with no bones keeps scale 1', () => {
    expect(normalisedRigScale([])).toBe(1);
  });

  // Measured, and it corrected this row's first draft: a rig collapsed to one point does NOT
  // have zero height, because a zero-length bone is still drawn at a minimum length. So the
  // answer is a finite scale, never a division by zero.
  it('a rig collapsed to one point still gets a finite, positive scale', () => {
    const s = normalisedRigScale(scaled(RIG, 0));
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });

  it('a caller that knows the unit gets scale 1, however big the rig is', () => {
    const { ops } = buildSkeletonObjectOps({
      skeletonId: 'sk',
      bones: scaled(RIG, 100),
      sceneNodeId: 'scene',
      normalise: false,
    });
    expect(ops[0]).toMatchObject({ params: { scale: [1, 1, 1] } });
  });
});
