// BVH import chain tests — verify the Op[] shape and that applying it
// builds a working Skeleton + AnimationClip.
//
// NO TIME WIRING (#920). `AnimationClip` is time-free, so the chain neither
// looks for a TimeSource nor connects one, and an empty DAG is a valid input.
// This mirrors what P7.10 (#114) did for the sibling carrier `TransformClip`.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, evaluate } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
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
  registerAllNodes();
  __resetBvhImportCounterForTests();
});

function buildStateWithTime() {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  return s;
}

describe('buildBvhImportOps', () => {
  it('emits addNode Skeleton + addNode AnimationClip + ONE connect', () => {
    const { ops, skeletonId, clipId } = buildBvhImportOps({
      text: SYNTHETIC_BVH,
      name: 'wave',
      ids: { skeleton: 'sk', clip: 'clip' },
    });
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ type: 'addNode', nodeId: 'sk', nodeType: 'Skeleton' });
    expect(ops[1]).toMatchObject({ type: 'addNode', nodeId: 'clip', nodeType: 'AnimationClip' });
    expect(ops[2]).toMatchObject({
      type: 'connect',
      from: { node: 'sk', socket: 'out' },
      to: { node: 'clip', socket: 'skeleton' },
    });
    expect(skeletonId).toBe('sk');
    expect(clipId).toBe('clip');
  });

  it('applying the chain yields a working AnimationClip evaluator', () => {
    let state = buildStateWithTime();
    const { ops, clipId } = buildBvhImportOps({
      text: SYNTHETIC_BVH,
      name: 'wave',
      ids: { skeleton: 'sk', clip: 'clip' },
    });
    for (const op of ops) state = applyOp(state, op).next;
    const result = evaluate(state, clipId, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    });
    const value = result.value as AnimationClipValue;
    expect(value.kind).toBe('AnimationClip');
    expect(value.name).toBe('wave');
    expect(value.duration).toBeGreaterThan(0);
    // The clip is a DESCRIPTION, not a sample (#920): it carries its keys and the
    // rig they are indexed against, and no pose. A consumer holding a Time samples
    // it. Asserting the keys and the rig travel together IS the row — a clip whose
    // indices arrived without their skeleton would name the wrong bones.
    expect(value.keyframes.length).toBeGreaterThan(0);
    expect(value.skeleton.bones.length).toBeGreaterThan(0);
    expect(Math.max(...value.keyframes.map((k) => k.bone))).toBeLessThan(
      value.skeleton.bones.length,
    );
  });

  it('twice-call builds deterministic Op chains for the same spec', () => {
    const a = buildBvhImportOps({
      text: SYNTHETIC_BVH,
      name: 'wave',
      ids: { skeleton: 'sk', clip: 'clip' },
    });
    const b = buildBvhImportOps({
      text: SYNTHETIC_BVH,
      name: 'wave',
      ids: { skeleton: 'sk', clip: 'clip' },
    });
    expect(a.ops).toEqual(b.ops);
  });

  // The OLD invariant — "a TimeSource MUST exist before importing animation" —
  // is GONE (#920), the same way P7.10 retired it for glTF. This inverts the old
  // assertion rather than deleting it: importing into an empty DAG must NOT
  // throw, and no emitted Op may mention TimeSource or a `time` socket.
  it('succeeds with no TimeSource in the DAG, and wires none', () => {
    const ops = buildBvhImportOps({
      text: SYNTHETIC_BVH,
      ids: { skeleton: 'sk', clip: 'clip' },
    }).ops;
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      if (op.type === 'addNode') expect(op.nodeType).not.toBe('TimeSource');
      if (op.type === 'connect') expect(op.to.socket).not.toBe('time');
    }
  });
});
