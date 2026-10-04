// #1056 — which skeleton Objects the armature band draws, and what poses each.
//
// Built on the project's DEFAULT graph, not a hand-rolled one: the world transform is resolved
// through the render output, exactly as the viewport resolves it, so a graph missing that
// output would make every row here pass or fail for a reason the product never meets. The
// default graph also carries an ordinary box Object, which is the negative control for free.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildBvhClipOps } from '../test-utils/bvhClip';
import { buildSkeletonObjectOps } from '../core/import/skeletonObject';
import { importGroupOp, parentEdge } from '../core/import/modelImport';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { collectSkeletonObjects } from './skeletonObjects';
import { evaluate } from '../core/dag/evaluator';
import { restBonePose } from '../nodes/bonePose';
import type { PosedSkeletonValue } from '../nodes/types';

/** A clip node's pose output, sampled — what an Object wired to it should play. */
function clipPoseAt(state: DagState, clipId: string, seconds: number) {
  return (evaluate(state, clipId, { socket: 'pose' }).value as PosedSkeletonValue).sample(seconds);
}

const BVH = `HIERARCHY
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

function apply(state: DagState, ops: readonly Op[]): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

/**
 * The default project, one imported BVH, and (unless `inScene` is false) its skeleton Object —
 * standing under the scene, or in an import Group `grp` under it when `inGroup`.
 */
function build({
  inScene = true,
  inGroup = false,
}: { inScene?: boolean; inGroup?: boolean } = {}): DagState {
  let s = buildDefaultDagState();
  const sceneNodeId = s.outputs.scene?.node;
  if (!sceneNodeId) throw new Error('default project has no scene output');
  s = apply(s, buildBvhClipOps({ text: BVH, ids: { skeleton: 'sk', clip: 'clip' } }).ops);
  if (inGroup)
    s = apply(s, [importGroupOp('grp', [0, 0, 0], [0, 0, 0]), parentEdge('grp', sceneNodeId)]);
  const { ops } = buildSkeletonObjectOps({
    skeletonId: 'sk',
    sceneNodeId: inGroup ? 'grp' : sceneNodeId,
    name: 'wave',
    clipId: 'clip',
    nameFollowsClip: true,
  });
  // Out of the scene: every op but the edge that makes it a scene child.
  const outOfScene = ops.filter((op) => !(op.type === 'connect' && op.to.socket === 'children'));
  return apply(s, inScene ? ops : outOfScene);
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('collectSkeletonObjects', () => {
  it('finds the Object, its skeleton, its world matrix and the one clip that poses it', () => {
    const [rig, ...rest] = collectSkeletonObjects(build());
    expect(rest).toHaveLength(0);
    expect(rig.id).toBe('sk_object');
    expect(rig.skeletonId).toBe('sk');
    // The BVH parser keeps the End Site as a bone of its own.
    expect(rig.bones.map((b) => b.name)).toEqual(['Hips', 'Spine', 'ENDSITE']);
    expect(rig.world).toHaveLength(16);
    expect(rig.clipCount).toBe(1);
    expect(rig.pose?.kind).toBe('PosedSkeleton');
  });

  it('with no clip wired, the rig rests — and says it has none', () => {
    // Deleted as the product deletes it: its consumers let go first (`sceneNodeActions.ts`).
    const s = apply(build(), [
      {
        type: 'disconnect',
        from: { node: 'clip', socket: 'pose' },
        to: { node: 'sk_object', socket: 'pose' },
      },
      { type: 'removeNode', nodeId: 'clip' },
    ]);
    const [rig] = collectSkeletonObjects(s);
    expect(rig.pose).toBeNull();
    expect(rig.clipCount).toBe(0);
  });

  // #1203 — the Object's own edge decides, as in Blender. Before it, two clips on one skeleton made
  // the rig rest, because the band had no way to know which was meant; the edge is that way. Since
  // #1224 the edge carries the clip's pose.
  it('with two clips wired, the Object plays its pose — and the count says there are two', () => {
    const base = build();
    const s = apply(base, [
      {
        type: 'addNode',
        nodeId: 'clip2',
        nodeType: 'AnimationClip',
        params: base.nodes.clip.params,
      },
      {
        type: 'connect',
        from: { node: 'sk', socket: 'out' },
        to: { node: 'clip2', socket: 'skeleton' },
      },
    ]);
    const [rig] = collectSkeletonObjects(s);
    const rest = rig.bones.map(restBonePose);
    expect(rig.pose!.sample(0.5)).toEqual(clipPoseAt(s, 'clip', 0.5));
    expect(rig.pose!.sample(0.5)).not.toEqual(rest);
    expect(rig.clipCount).toBe(2);
    // Re-pointed at a third clip — one with no keys, so it rests — the pose follows the edge, not
    // an order among clips.
    const repointed = apply(s, [
      {
        type: 'addNode',
        nodeId: 'clip3',
        nodeType: 'AnimationClip',
        params: { ...(base.nodes.clip.params as object), name: 'third', poses: [] },
      },
      {
        type: 'connect',
        from: { node: 'sk', socket: 'out' },
        to: { node: 'clip3', socket: 'skeleton' },
      },
      {
        type: 'connect',
        from: { node: 'clip3', socket: 'pose' },
        to: { node: 'sk_object', socket: 'pose' },
      },
    ]);
    expect(collectSkeletonObjects(repointed)[0].pose!.sample(0.5)).toEqual(rest);
  });

  it('a pose made for a different rig poses nothing, rather than the wrong bones', () => {
    const base = build();
    const s = apply(base, [
      {
        type: 'addNode',
        nodeId: 'other',
        nodeType: 'Skeleton',
        params: {
          bones: [{ name: 'elsewhere', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] }],
        },
      },
      {
        type: 'addNode',
        nodeId: 'clipOther',
        nodeType: 'AnimationClip',
        params: base.nodes.clip.params,
      },
      {
        type: 'connect',
        from: { node: 'other', socket: 'out' },
        to: { node: 'clipOther', socket: 'skeleton' },
      },
      {
        type: 'connect',
        from: { node: 'clipOther', socket: 'pose' },
        to: { node: 'sk_object', socket: 'pose' },
      },
    ]);
    const [rig] = collectSkeletonObjects(s);
    expect(rig.pose).toBeNull();
  });

  it('an Object that is not in the scene is not drawn', () => {
    expect(collectSkeletonObjects(build({ inScene: false }))).toEqual([]);
  });

  /** #1503 — a node with its viewport flag off, as the outliner's eye leaves it. */
  const viewportOff = <N extends { params: unknown }>(n: N): N => ({
    ...n,
    params: { ...(n.params as object), viewport: false },
  });

  it('a hidden Object is not drawn', () => {
    const s = build();
    const hidden: DagState = {
      ...s,
      nodes: { ...s.nodes, sk_object: viewportOff(s.nodes.sk_object) },
    };
    expect(collectSkeletonObjects(hidden)).toEqual([]);
  });

  // #1462 — Blender hides an object alone (observed in Blender 5.1.1 headless: hiding a parent
  // leaves its child visible), and the viewport draws a hidden Group's children, so a rig under a
  // hidden Group keeps its bones. Hiding the rig itself is the control: then they go.
  it('an Object in a hidden Group is still drawn; hidden itself, it is not', () => {
    const s = build({ inGroup: true });
    expect(collectSkeletonObjects(s).map((o) => o.id)).toEqual(['sk_object']);
    const groupHidden: DagState = {
      ...s,
      nodes: { ...s.nodes, grp: viewportOff(s.nodes.grp) },
    };
    expect(collectSkeletonObjects(groupHidden).map((o) => o.id)).toEqual(['sk_object']);
    const rigHidden: DagState = {
      ...groupHidden,
      nodes: {
        ...groupHidden.nodes,
        sk_object: viewportOff(groupHidden.nodes.sk_object),
      },
    };
    expect(collectSkeletonObjects(rigHidden)).toEqual([]);
  });

  // NEGATIVE CONTROL: only skeleton data qualifies. The default project already stands an
  // Object pointed at box data in the same scene, and it must not be reported as a rig.
  it('an Object whose data is not a skeleton is not a skeleton Object', () => {
    const s = build();
    const otherObjects = Object.values(s.nodes).filter(
      (n) => n.type === 'Object' && n.id !== 'sk_object' && n.inputs.data,
    );
    expect(otherObjects.length).toBeGreaterThan(0);
    expect(collectSkeletonObjects(s).map((r) => r.id)).toEqual(['sk_object']);
  });
});
