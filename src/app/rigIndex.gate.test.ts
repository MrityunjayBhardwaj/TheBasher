// #1732 — a bone found by name is a lookup, not a crawl through the scene.
//
// The fixture is the #1638 one: an imported BVH rig (Hips, Spine) standing in an import Group
// `grp` whose position is keyed 0 → 10 m along z over 2 s, so the bones travel and turn.
//
// Parity is checked against what the viewport DRAWS, not against the code this replaced: the
// armature helper's own reader (`collectSkeletonObjects` + `skeletonObjectFrames`) at 20 times.
//
// Cost is counted, not timed: evaluate calls through the evaluator's perf hook (cache hits
// included), and reads of the node table through a Proxy on `state.nodes` (every scan or lookup a
// graph walk makes). Once the armature is posed for a time, another bone at that time costs 0 of
// each.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import { __setEvalPerfHook, bumpEvaluatorContentEpoch } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildBvhClipOps } from '../test-utils/bvhClip';
import { buildSkeletonObjectOps } from '../core/import/skeletonObject';
import { importGroupOp, parentEdge } from '../core/import/modelImport';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { collectSkeletonObjects } from './skeletonObjects';
import { skeletonObjectFrames } from '../viewport/skeletonObjectPose';
import { gltfNodeWorldPosition } from './gltfNodeWorld';
import { armatureOf, armaturePoseAt, rigsFor } from './rigIndex';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});
afterEach(() => __setEvalPerfHook(null));

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
Frames: 3
Frame Time: 0.5
0.0 1.0 0.0 0.0 0.0 0.0 0.0 45.0 0.0
0.3 1.2 0.0 10.0 0.0 0.0 30.0 -45.0 0.0
0.0 1.0 0.5 0.0 20.0 0.0 0.0 0.0 60.0
`;

function apply(state: DagState, ops: readonly Op[]): DagState {
  let s = state;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

/** The rig in import Group `grp`, the Group keyed 0 → 10 m along z over 2 s. */
function travelling(): DagState {
  let s = buildDefaultDagState();
  const scene = s.outputs.scene!.node;
  s = apply(s, buildBvhClipOps({ text: BVH, ids: { skeleton: 'sk', clip: 'clip' } }).ops);
  s = apply(s, [importGroupOp('grp', [0, 0, 0], [0, 0, 0]), parentEdge('grp', scene)]);
  s = apply(
    s,
    buildSkeletonObjectOps({
      skeletonId: 'sk',
      sceneNodeId: 'grp',
      name: 'wave',
      clipId: 'clip',
      nameFollowsClip: true,
    }).ops,
  );
  return applyOp(s, {
    type: 'addNode',
    nodeId: 'grp_position_channel',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'grp',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 2, value: [0, 0, 10], easing: 'linear' },
      ],
    },
  }).next;
}

const at = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

/** Where the armature helper draws bone `name`'s head at `seconds`. */
function drawnHead(state: DagState, name: string, seconds: number) {
  const [rig] = collectSkeletonObjects(state);
  return skeletonObjectFrames(rig, seconds).find((f) => f.name === name)!.head;
}

describe('#1732 — a bone by name, where it is drawn', () => {
  it('Hips and Spine match the armature helper to 1e-6 at 20 times', () => {
    const state = travelling();
    let compared = 0;
    let travelled = 0;
    for (let k = 0; k < 20; k++) {
      const s = (k / 19) * 2.2;
      for (const bone of ['Hips', 'Spine']) {
        const got = gltfNodeWorldPosition(state, 'grp', bone, at(s));
        const want = drawnHead(state, bone, s);
        expect(got, `${bone} at ${s}`).not.toBeNull();
        got!.forEach((v, i) =>
          expect(Math.abs(v - want[i]), `${bone} axis ${i} at ${s}`).toBeLessThan(1e-6),
        );
        compared += 1;
        if (bone === 'Hips') travelled = Math.max(travelled, Math.abs(got![2]));
      }
    }
    expect(compared).toBe(40);
    // The rows are not 40 copies of the rest pose: the Hips travel with the Group.
    expect(travelled).toBeGreaterThan(9);
  });

  it('no such bone, or nothing standing for a rig, is null', () => {
    const state = travelling();
    expect(gltfNodeWorldPosition(state, 'grp', 'no_such_bone', at(1))).toBeNull();
    expect(gltfNodeWorldPosition(state, 'n_light', 'Hips', at(1))).toBeNull();
  });

  it('a second bone at the same time makes 0 evaluate calls and reads no node', () => {
    const base = travelling();
    let reads = 0;
    const nodes = new Proxy(base.nodes, {
      get(target, key, receiver) {
        if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(target, key))
          reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const state = { ...base, nodes } as DagState;
    let evals = 0;
    __setEvalPerfHook(() => {
      evals += 1;
    });
    // The first lookup at t = 1.3 reads the rig and poses and places the armature for that time.
    expect(gltfNodeWorldPosition(state, 'grp', 'Hips', at(1.3))).not.toBeNull();
    const first = { evals, reads };
    evals = 0;
    reads = 0;
    expect(gltfNodeWorldPosition(state, 'grp', 'Spine', at(1.3))).not.toBeNull();
    console.log(
      `[#1732] first lookup at a time: ${first.evals} evaluate calls, ${first.reads} node reads; ` +
        `the next bone at that time: ${evals} and ${reads}`,
    );
    expect(first.evals).toBeGreaterThan(0);
    expect(evals).toBe(0);
    expect(reads).toBe(0);
  });

  it('the armature is posed once per time: the same array until another time is asked', () => {
    const state = travelling();
    const [rig] = rigsFor(state, 'grp');
    const a = armaturePoseAt(state, rig.objectId, 0.7);
    expect(a).toBeInstanceOf(Float64Array);
    expect(a!.length).toBe(armatureOf(state, rig.objectId)!.bones.length * 16);
    expect(armaturePoseAt(state, rig.objectId, 0.7)).toBe(a);
    const b = armaturePoseAt(state, rig.objectId, 1.1);
    expect(b).not.toBe(a);
    expect(Array.from(b!)).not.toEqual(Array.from(a!));
  });

  it('an edit, or content arriving later, is read afresh', () => {
    let state = travelling();
    const before = gltfNodeWorldPosition(state, 'grp', 'Hips', at(1))!;
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'grp_position_channel',
      paramPath: 'keyframes',
      value: [
        { time: 0, value: [5, 0, 0], easing: 'linear' },
        { time: 2, value: [5, 0, 10], easing: 'linear' },
      ],
    }).next;
    const after = gltfNodeWorldPosition(state, 'grp', 'Hips', at(1))!;
    expect(after[0] - before[0]).toBeCloseTo(5, 9);
    // A content-epoch bump (an asset finished loading) drops what was kept for this graph.
    const [rig] = rigsFor(state, 'grp');
    const kept = armaturePoseAt(state, rig.objectId, 1);
    bumpEvaluatorContentEpoch();
    expect(armaturePoseAt(state, rig.objectId, 1)).not.toBe(kept);
  });
});
