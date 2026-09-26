// #1250 — a retarget's source rig, read from what the retarget actually reads: the pose wire.
//
// The reference rig and the bone-map editor used to find the source rig off a CLIP's `skeleton`
// edge, so a retarget whose source is a pose layer (a character's own motion as keys, or a BVH once
// it lands as keys, #1211) drew no reference rig and opened no editor. The overlay now evaluates the
// source on the socket its edge names; the editor walks the node table with `poseSkeletonIdOf`.
// That walk is checked here against the evaluated wire for EVERY node type with a pose output.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  applyOp,
  emptyDagState,
  evaluate,
  getNodeType,
  listNodeTypes,
} from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import type { BoneSpec, PosedSkeletonValue, SkeletonValue } from '../../nodes/types';
import { poseSkeletonIdOf } from './poseChain';
import { retargetPairs } from './boundClipsForAsset';
import { boneMapView } from './boneMapRows';
import type { GraphNodeLike } from './graphNodes';

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
 *   src_layer (PoseLayer over swing_skel.pose) · over (PoseOverride over src_layer)
 *   tgt (Skeleton) · r_layer (RetargetClip: src_layer → tgt) · r_clip (RetargetClip: swing_clip → tgt) */
function graph(): DagState {
  let s = emptyDagState();
  const motion = buildBvhImportOps({
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
    { type: 'addNode', nodeId: 'over', nodeType: 'PoseOverride', params: { bone: 'Bone1' } },
    {
      type: 'connect',
      from: { node: 'src_layer', socket: 'out' },
      to: { node: 'over', socket: 'pose' },
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

const nodesOf = (s: DagState) => s.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
const AT0 = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } };

/** Every registered node type's outputs that carry a pose. */
function poseOutputs(): { type: string; socket: string }[] {
  const out: { type: string; socket: string }[] = [];
  for (const type of listNodeTypes()) {
    for (const [socket, spec] of Object.entries(getNodeType(type)?.outputs ?? {})) {
      if ((spec as { type?: string }).type === 'PosedSkeleton') out.push({ type, socket });
    }
  }
  return out.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/** One instance per pose producer in `graph()`, with the socket its pose comes out on. */
const PRODUCERS: Record<string, { id: string; socket: string }> = {
  Skeleton: { id: 'swing_skel', socket: 'pose' },
  AnimationClip: { id: 'swing_clip', socket: 'pose' },
  PoseLayer: { id: 'src_layer', socket: 'out' },
  PoseOverride: { id: 'over', socket: 'out' },
  PosedSkeleton: { id: 'sway', socket: 'out' },
  RetargetClip: { id: 'r_layer', socket: 'posed' },
};

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('poseSkeletonIdOf — the params-side answer agrees with the wire', () => {
  it('CENSUS: every node type with a pose output is one this walk knows', () => {
    // A new pose producer reds here until the walk names it, rather than drawing no reference rig.
    expect(poseOutputs().map((o) => `${o.type}.${o.socket}`)).toEqual(
      Object.entries(PRODUCERS)
        .map(([type, p]) => `${type}.${p.socket}`)
        .sort(),
    );
  });

  for (const [type, p] of Object.entries(PRODUCERS)) {
    it(`${type}: the rig the walk names is the rig on the evaluated wire`, () => {
      const s = graph();
      expect(s.nodes[p.id]?.type).toBe(type);
      const wire = evaluate(s, p.id, { ...AT0, socket: p.socket }).value as PosedSkeletonValue;
      expect(wire.kind).toBe('PosedSkeleton');
      const rigId = poseSkeletonIdOf(nodesOf(s), p.id);
      expect(rigId).not.toBeNull();
      const rig = evaluate(s, rigId!, { ...AT0, socket: 'out' }).value as SkeletonValue;
      expect(rig.bones.map((b) => b.name)).toEqual(wire.skeleton.bones.map((b) => b.name));
      expect(rig.bones.length).toBeGreaterThan(0);
    });
  }

  it('the retarget stands its TARGET rig, not its source', () => {
    expect(poseSkeletonIdOf(nodesOf(graph()), 'r_layer')).toBe('tgt');
  });

  it('answers null for an unwired layer, a non-pose node and a cycle', () => {
    let s = graph();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'loose',
      nodeType: 'PoseLayer',
      params: { name: 'loose', mode: 'override', members: [], channels: [] },
    }).next;
    expect(poseSkeletonIdOf(nodesOf(s), 'loose')).toBeNull();
    expect(poseSkeletonIdOf(nodesOf(s), 'r_layer_map')).toBeNull();
    expect(poseSkeletonIdOf(nodesOf(s), 'missing')).toBeNull();
    const cyc = {
      a: { type: 'PoseLayer', inputs: { pose: { node: 'b', socket: 'out' } } },
      b: { type: 'PoseLayer', inputs: { pose: { node: 'a', socket: 'out' } } },
    } as unknown as Readonly<Record<string, GraphNodeLike>>;
    expect(poseSkeletonIdOf(cyc, 'a')).toBeNull();
  });
});

describe('a retarget whose source is a pose layer', () => {
  it('opens the bone-map editor, with the source rig’s bones — the same as a clip source', () => {
    const s = graph();
    const fromLayer = boneMapView(nodesOf(s), 'r_layer');
    const fromClip = boneMapView(nodesOf(s), 'r_clip');
    expect(fromClip).not.toBeNull();
    expect(fromLayer).not.toBeNull();
    expect(fromLayer!.rows.map((r) => r.source)).toEqual(fromClip!.rows.map((r) => r.source));
    // …and they are the source rig's bones (the BVH end site included), not the target's.
    expect([...fromLayer!.rows.map((r) => r.source)].sort()).toEqual(['Bone0', 'Bone1', 'ENDSITE']);
  });

  it('pairs for the reference rig on the socket the edge reads, and that socket gives a pose', () => {
    const s = graph();
    const pairs = retargetPairs(nodesOf(s));
    expect(pairs.map((p) => [p.retargetId, p.sourceId, p.sourceSocket])).toEqual([
      ['r_clip', 'swing_clip', 'pose'],
      ['r_layer', 'src_layer', 'out'],
    ]);
    for (const p of pairs) {
      const wire = evaluate(s, p.sourceId, { ...AT0, socket: p.sourceSocket })
        .value as PosedSkeletonValue;
      expect(wire.kind, p.retargetId).toBe('PosedSkeleton');
      expect(
        wire.skeleton.bones.map((b) => b.name),
        p.retargetId,
      ).toEqual(
        (evaluate(s, 'swing_skel', { ...AT0, socket: 'out' }).value as SkeletonValue).bones.map(
          (b) => b.name,
        ),
      );
    }
  });
});
