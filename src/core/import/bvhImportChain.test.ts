// BVH import chain tests — verify the Op[] shape and that applying it
// builds a working Skeleton + AnimationClip + Time wiring.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  applyOp,
  emptyDagState,
  evaluate,
} from '../dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { buildBvhImportOps, __resetBvhImportCounterForTests } from './bvhImportChain';
import type { AnimationClipValue } from '../../nodes/types';

const SYNTHETIC_BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 1.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT Spine
  {
    OFFSET 0.0 0.5 0.0
    CHANNELS 3 Xrotation Yrotation Zrotation
    End Site
    {
      OFFSET 0.0 0.5 0.0
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333
0.0 1.0 0.0 0.0 0.0 0.0 0.0 45.0 0.0
0.0 1.0 0.0 0.0 0.0 0.0 0.0 -45.0 0.0
`;

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  __resetBvhImportCounterForTests();
});

function buildStateWithTime() {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  return s;
}

describe('buildBvhImportOps', () => {
  it('emits addNode Skeleton + addNode AnimationClip + 2 connects', () => {
    const state = buildStateWithTime();
    const { ops, skeletonId, clipId } = buildBvhImportOps(
      { text: SYNTHETIC_BVH, name: 'wave', ids: { skeleton: 'sk', clip: 'clip' } },
      state,
    );
    expect(ops).toHaveLength(4);
    expect(ops[0]).toMatchObject({ type: 'addNode', nodeId: 'sk', nodeType: 'Skeleton' });
    expect(ops[1]).toMatchObject({ type: 'addNode', nodeId: 'clip', nodeType: 'AnimationClip' });
    expect(ops[2]).toMatchObject({ type: 'connect', from: { node: 'sk', socket: 'out' }, to: { node: 'clip', socket: 'skeleton' } });
    expect(ops[3]).toMatchObject({ type: 'connect', from: { node: 'time', socket: 'out' }, to: { node: 'clip', socket: 'time' } });
    expect(skeletonId).toBe('sk');
    expect(clipId).toBe('clip');
  });

  it('applying the chain yields a working AnimationClip evaluator', () => {
    let state = buildStateWithTime();
    const { ops, clipId } = buildBvhImportOps(
      { text: SYNTHETIC_BVH, name: 'wave', ids: { skeleton: 'sk', clip: 'clip' } },
      state,
    );
    for (const op of ops) state = applyOp(state, op).next;
    const result = evaluate(state, clipId, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    });
    const value = result.value as AnimationClipValue;
    expect(value.kind).toBe('AnimationClip');
    expect(value.name).toBe('wave');
    expect(value.duration).toBeGreaterThan(0);
    expect(value.pose.kind).toBe('PosedSkeleton');
    expect(value.pose.poses.length).toBeGreaterThan(0);
  });

  it('twice-call builds deterministic Op chains for the same spec', () => {
    const state = buildStateWithTime();
    const a = buildBvhImportOps(
      { text: SYNTHETIC_BVH, name: 'wave', ids: { skeleton: 'sk', clip: 'clip' } },
      state,
    );
    const b = buildBvhImportOps(
      { text: SYNTHETIC_BVH, name: 'wave', ids: { skeleton: 'sk', clip: 'clip' } },
      state,
    );
    expect(a.ops).toEqual(b.ops);
  });

  it('throws when no TimeSource exists in the project', () => {
    const state = emptyDagState();
    expect(() =>
      buildBvhImportOps({ text: SYNTHETIC_BVH, ids: { skeleton: 'sk', clip: 'clip' } }, state),
    ).toThrow(/TimeSource/);
  });

  it('honors an explicit timeSourceId override', () => {
    let state = buildStateWithTime();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'time2',
      nodeType: 'TimeSource',
      params: {},
    }).next;
    const { ops } = buildBvhImportOps(
      {
        text: SYNTHETIC_BVH,
        timeSourceId: 'time2',
        ids: { skeleton: 'sk', clip: 'clip' },
      },
      state,
    );
    expect(ops[3]).toMatchObject({
      type: 'connect',
      from: { node: 'time2', socket: 'out' },
    });
  });
});
