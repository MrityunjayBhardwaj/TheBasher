// #1250 — Show Source Rig says what it drew. Every wired retarget is either drawn beside its
// character or skipped with a reason, and the View menu reads the count, zero included: turning the
// overlay on and seeing nothing must not be the only answer.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildBvhClipOps } from '../../test-utils/bvhClip';
import type { BoneSpec } from '../../nodes/types';
import { collectReferenceRigs, referenceRigsReadout } from './referenceRigs';

// The graph of `poseSourceRig.test.ts`: two retargets onto `tgt`, one reading a clip's pose, one a
// pose layer's.
const SWING_BVH = `HIERARCHY
ROOT Bone0
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Bone1
  {
    OFFSET 0 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 1 0
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
0 0 0 0 0 0 45 0 0
`;

/** The target rig, named apart from the source so a walk that lands on the wrong rig shows. */
const TARGET_BONES: BoneSpec[] = [
  { name: 'Hip', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'Arm', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
];

/** Every pose producer in one graph:
 *   swing_skel (Skeleton) · swing_clip (AnimationClip on swing_skel) · sway (PosedSkeleton on it)
 *   src_layer (PoseLayer over swing_skel.pose)
 *   tgt (Skeleton) · r_layer (RetargetClip: src_layer → tgt) · r_clip (RetargetClip: swing_clip → tgt) */
function graph(): DagState {
  let s = emptyDagState();
  const motion = buildBvhClipOps({
    text: SWING_BVH,
    name: 'swing',
    ids: { skeleton: 'swing_skel', clip: 'swing_clip' },
  });
  const ops: Op[] = [
    ...motion.ops,
    { type: 'addNode', nodeId: 'tgt', nodeType: 'Skeleton', params: { bones: TARGET_BONES } },
    {
      type: 'addNode',
      nodeId: 'src_layer',
      nodeType: 'PoseLayer',
      params: {
        name: 'swing',
        mode: 'override',
        members: [{ bone: 'Bone1', rotationMode: 'quaternion' }],
        channels: [
          {
            bone: 'Bone1',
            component: 'quaternion',
            keyframes: [
              { time: 0, value: [0, 0, 0, 1], easing: 'linear' },
              { time: 1, value: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], easing: 'linear' },
            ],
          },
        ],
      },
    },
    {
      type: 'connect',
      from: { node: 'swing_skel', socket: 'pose' },
      to: { node: 'src_layer', socket: 'pose' },
    },
    { type: 'addNode', nodeId: 'sway', nodeType: 'PosedSkeleton', params: {} },
    {
      type: 'connect',
      from: { node: 'swing_skel', socket: 'out' },
      to: { node: 'sway', socket: 'skeleton' },
    },
  ];
  for (const [id, sourceId, sourceSocket] of [
    ['r_layer', 'src_layer', 'out'],
    ['r_clip', 'swing_clip', 'pose'],
  ] as const) {
    ops.push(
      {
        type: 'addNode',
        nodeId: `${id}_map`,
        nodeType: 'BoneNameMap',
        params: { name: 'map', map: { Bone0: 'Hip', Bone1: 'Arm' } },
      },
      { type: 'addNode', nodeId: id, nodeType: 'RetargetClip', params: { name: id, active: true } },
      {
        type: 'connect',
        from: { node: sourceId, socket: sourceSocket },
        to: { node: id, socket: 'source' },
      },
      {
        type: 'connect',
        from: { node: `${id}_map`, socket: 'out' },
        to: { node: id, socket: 'boneMap' },
      },
      {
        type: 'connect',
        from: { node: 'tgt', socket: 'out' },
        to: { node: id, socket: 'skeleton' },
      },
    );
  }
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

const apply = (s: DagState, ops: Op[]) => ops.reduce((acc, op) => applyOp(acc, op).next, s);
const reasons = (found: ReturnType<typeof collectReferenceRigs>) =>
  Object.fromEntries(found.skipped.map((k) => [k.retargetId, k.reason]));

describe('#1250 — Show Source Rig says what it drew, and why it did not draw the rest', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('both retargets drawn when a character stands the rig they drive', () => {
    const found = collectReferenceRigs(graph(), new Set(['tgt']));
    expect(found.rigs.map((r) => r.id)).toEqual(['r_clip', 'r_layer']);
    expect(found.skipped).toEqual([]);
    expect(referenceRigsReadout(found)).toBe('2 of 2 drawn');
  });

  it('no character stands the rig: both skipped, by name, and the count says 0', () => {
    const found = collectReferenceRigs(graph(), new Set());
    expect(found.rigs).toEqual([]);
    expect(reasons(found)).toEqual({
      r_clip: 'no character stands the rig it drives',
      r_layer: 'no character stands the rig it drives',
    });
    expect(referenceRigsReadout(found)).toBe('0 of 2 drawn');
  });

  it('a rig with no bones to drive is named as that', () => {
    const s = apply(graph(), [{ type: 'setParam', nodeId: 'tgt', paramPath: 'bones', value: [] }]);
    expect(reasons(collectReferenceRigs(s, new Set(['tgt'])))).toEqual({
      r_clip: 'the rig it drives has no bones',
      r_layer: 'the rig it drives has no bones',
    });
  });

  it('a source with no rig (a layer over nothing) is named as that; the other is still drawn', () => {
    const s = apply(graph(), [
      { type: 'addNode', nodeId: 'lonely', nodeType: 'PoseLayer', params: { name: 'lonely' } },
      {
        type: 'connect',
        from: { node: 'lonely', socket: 'out' },
        to: { node: 'r_layer', socket: 'source' },
      },
    ]);
    const found = collectReferenceRigs(s, new Set(['tgt']));
    expect(found.rigs.map((r) => r.id)).toEqual(['r_clip']);
    expect(reasons(found)).toEqual({ r_layer: 'its source has no rig to draw' });
    expect(referenceRigsReadout(found)).toBe('1 of 2 drawn');
  });

  it('no retarget at all says so rather than nothing', () => {
    const found = collectReferenceRigs(emptyDagState(), new Set());
    expect(referenceRigsReadout(found)).toBe('no retarget to draw');
  });
});
