// #1056 — every imported motion gets an Object of its own. These rows pin the ops, the
// socket that admits the skeleton, and the scale that stands an unknown-unit rig up.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../dag';
import type { DagState } from '../dag/state';
import { registerAllNodes } from '../../nodes/registerAll';
import type { AnimationClipValue, BoneSpec, ObjectValue } from '../../nodes/types';
import { boneTransforms } from '../../viewport/boneShape';
import { armatureBounds, posedSourceBones } from '../../viewport/referenceRig';
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
  it('stands an upright rest pose at the rig height', () => {
    const s = normalisedRigScale(RIG);
    const height = armatureBounds(boneTransforms(scaled(RIG, s))).height;
    expect(height).toBeCloseTo(UNBOUND_RIG_HEIGHT_METRES, 6);
  });

  // The rest pose a BVH declares need not stand up. The same rig lying along +X is the same
  // size, and must get the same scale — a Y-extent measure reads its width as its height.
  it('does not care which way the rest pose faces — a rig lying along +X gets the same scale', () => {
    const lying = RIG.map((b) => ({
      ...b,
      position: [b.position[1], -b.position[0], b.position[2]] as BoneSpec['position'],
    }));
    expect(armatureBounds(boneTransforms(lying)).height).toBeLessThan(1);
    expect(normalisedRigScale(lying)).toBeCloseTo(normalisedRigScale(RIG), 6);
  });

  // THE ABSOLUTE ROW, on the real file. The rows above are relative (invariance), and every one
  // of them stayed green while `soma-walk.bvh` drew ~27× too big (rest pose Y extent), and
  // again at 1.17 m (rest pose longest extent: it lies along +X with its arms raised). So this
  // reads what is DRAWN — the clip's frame-0 pose, at the scale set from that clip — and asks
  // that it be the height of a person.
  it('stands the real soma-walk.bvh at human height as drawn, posed at frame 0', () => {
    let state = sceneState();
    const text = readFileSync(resolve(process.cwd(), 'public/fixtures/anim/soma-walk.bvh'), 'utf8');
    const imported = buildBvhImportOps({ text, ids: { skeleton: 'sk', clip: 'clip' } });
    for (const op of imported.ops) state = applyOp(state, op).next;
    const bones = (state.nodes.sk.params as { bones: BoneSpec[] }).bones;
    const clip = evaluate(state, 'clip', {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as AnimationClipValue;
    expect(clip.kind).toBe('AnimationClip');

    const s = normalisedRigScale(bones, clip);
    const drawn = armatureBounds(boneTransforms(scaled(posedSourceBones(clip, 0), s))).height;
    expect(drawn).toBeGreaterThan(1.5);
    expect(drawn).toBeLessThan(2.1);
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
