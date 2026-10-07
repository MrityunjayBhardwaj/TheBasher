// #1357 — a Rig in an armature's pose chain, as the chain's readers and writers see it.
//
// The rig of `ikLayerChain.test.ts` (upper → lower → tip, control bones `goal` and `pole`), with the
// ik layer moved INSIDE a Rig:
//
//   Skeleton.pose → base → Rig.pose          Rig.out → Object.pose
//                           BodyInputPose → ik → Rig.body
//
// What must hold, each the Rig counterpart of a rule the ik layer already has:
//   1. the walk passes through the Rig: the base under it is still the chain's base;
//   2. a hand-pose is FK and lands UNDER the Rig, never above it;
//   3. the gizmo's inversion refuses a bone the Rig changes, by name, and still inverts one it only
//      hands through; a layer inside the Rig is refused as inside;
//   4. renaming a bone renames it inside the Rig;
//   5. a bind replaces the motion under the Rig; a bake above a Rig is refused;
//   6. the timeline shows the keys of the layers inside; a key names a bone of the rigged skeleton.
import { beforeEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  __resetRegistryForTests,
  applyOp,
  evaluate,
  getNodeType,
  listNodeTypes,
} from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import type { BoneSpec, ObjectValue, PosedSkeletonValue, Quat } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { bindPosedOps } from '../../agent/mutators/builders/retarget';
import { resolveChannelAddress } from '../../agent/mutators/builders/channelAddress';
import { useDiffStore } from '../../agent/diff/store';
import { layerChannelRows } from '../../timeline/layerChannelRows';
import { useAutoKeyStore } from '../stores/autoKeyStore';
import { dispatchMutatorFromUI } from './dispatchMutator';
import {
  POSE_CHAIN_HOPS,
  POSE_CHAIN_SOURCES_WITH_A_POSE_INPUT,
  handPoseInsertionOf,
  handPoseLayerOf,
  poseLayerChain,
} from './poseChain';
import { layerValueForDrawn } from './invertPoseStack';
import { bakePose } from './bakePose';
import { renameBone } from './renameBone';
import { posedWorldMatrices } from '../../viewport/boneShape';
import type { GraphNodeLike } from './graphNodes';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
  useAutoKeyStore.setState({ enabled: false });
});

const TURN = 2 * Math.atan2(0.024976602, 0.999688029);
const LEN = 1.001249194;
const BONES: BoneSpec[] = [
  { name: 'upper', parent: -1, position: [0, 0, 0], rotation: [TURN, 0, 0] },
  { name: 'lower', parent: 0, position: [0, LEN, 0], rotation: [-2 * TURN, 0, 0] },
  { name: 'tip', parent: 1, position: [0, LEN, 0], rotation: [0, 0, 0] },
  { name: 'goal', parent: -1, position: [0.8, 1.2, 0.5], rotation: [0, 0, 0] },
  { name: 'pole', parent: -1, position: [0, 1, 2], rotation: [0, 0, 0] },
];
const GOAL = new Vector3(0.8, 1.2, 0.5);
const ARM = 'n_rig_arm';
const RIG = 'n_rig';
const IK = 'n_rig_ik';
const BASE = 'n_rig_base';
const T = 0.5;
const live = () => useDagStore.getState().state;
const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
  ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;

function rigged(ikWeight = 1): DagState {
  return apply(buildDefaultDagState(), [
    node('n_rig_skel', 'Skeleton', { bones: BONES }),
    node(BASE, 'PoseLayer', { name: 'base', mode: 'override', members: [] }),
    wire('n_rig_skel', BASE, 'pose', 'pose'),
    node('n_rig_in', 'BodyInputPose'),
    node(IK, 'PoseLayer', {
      name: 'arm ik',
      mode: 'ik',
      weight: ikWeight,
      ik: { root: 'upper', mid: 'lower', tip: 'tip', goal: 'goal', pole: 'pole' },
      channels: [
        {
          component: 'weight',
          mute: true,
          keyframes: [
            { time: 0, value: 1, easing: 'linear' },
            { time: 1, value: 0, easing: 'linear' },
          ],
        },
      ],
    }),
    wire('n_rig_in', IK, 'pose'),
    node(RIG, 'Rig'),
    wire(IK, RIG, 'body'),
    wire(BASE, RIG, 'pose'),
    node(ARM, 'Object'),
    wire(RIG, ARM, 'pose'),
    wire('n_rig_skel', ARM, 'data'),
  ]);
}

function heads(): Vector3[] {
  const v = evaluate(live(), ARM, {
    ctx: { time: { frame: 0, seconds: T, normalized: 0 } } as never,
  }).value as ObjectValue;
  const pose = (v as { pose?: PosedSkeletonValue }).pose!.sample(T);
  return posedWorldMatrices(BONES, pose).map((m) => new Vector3().setFromMatrixPosition(m));
}

describe('#1357 — the rig inside the Rig solves (the chain the writers walk is live)', () => {
  it('the tip is on the goal', () => {
    useDagStore.getState().hydrate(rigged());
    expect(heads()[2].distanceTo(GOAL)).toBeLessThan(1e-6);
  });
});

describe('#1357 — the walk passes through a Rig', () => {
  it('the base under the Rig is the chain’s base; the layers inside are named apart', () => {
    const chain = poseLayerChain(graph(rigged()), ARM);
    expect(chain.hops).toEqual([
      { id: RIG, kind: 'rig' },
      { id: BASE, kind: 'layer' },
    ]);
    expect(chain.layers).toEqual([BASE]);
    expect(chain.allLayers).toEqual([IK, BASE]);
    expect(chain.bottom).toBe(BASE);
    expect(chain.base).toBe(BASE);
    expect(chain.source).toEqual({ node: 'n_rig_skel', socket: 'pose' });
  });

  it('a Rig reading the rest pose directly is the bottom, and there is no base', () => {
    const s = apply(
      rigged(),
      [wire('n_rig_skel', RIG, 'pose', 'pose')].map((op) => ({ ...op, replace: true }) as Op),
    );
    const chain = poseLayerChain(graph(s), ARM);
    expect(chain.bottom).toBe(RIG);
    expect(chain.base).toBeNull();
    expect(chain.layers).toEqual([]);
  });

  it('CENSUS: every node that takes a pose and gives one is a hop or a named source', () => {
    const POSE = 'PosedSkeleton';
    const both = listNodeTypes()
      .filter((type) => {
        const def = getNodeType(type)!;
        const takes = Object.values(def.inputs).some((d) => d.type === POSE && d.body !== true);
        return takes && Object.values(def.outputs).some((d) => d.type === POSE);
      })
      .sort();
    expect(both).toEqual(
      [...Object.keys(POSE_CHAIN_HOPS), ...POSE_CHAIN_SOURCES_WITH_A_POSE_INPUT].sort(),
    );
    // Every hop reads the pose under it on a socket named `pose`: the walk follows that name.
    for (const type of Object.keys(POSE_CHAIN_HOPS)) {
      expect(getNodeType(type)!.inputs.pose?.type, type).toBe(POSE);
    }
  });
});

describe('#1357 — a hand-pose is FK: it goes under the Rig', () => {
  it('posing a chain bone inserts the hand-pose layer under the Rig', () => {
    useDagStore.getState().hydrate(rigged());
    expect(handPoseLayerOf(graph(live()), ARM)).toBeNull();
    expect(handPoseInsertionOf(graph(live()), ARM)).toBe(RIG);
    const res = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: ARM, bone: 'lower', rotation: [0, 0, 40] },
      'pose',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const { hops } = poseLayerChain(graph(live()), ARM);
    expect(hops.map((h) => h.kind)).toEqual(['rig', 'layer', 'layer']);
    expect(handPoseLayerOf(graph(live()), ARM)).toBe(hops[1].id);
    // The solve inside still owns the drawn chain: the tip stays on the goal.
    expect(heads()[2].distanceTo(GOAL)).toBeLessThan(1e-6);
  });

  it('an override layer above the Rig is not where a hand-pose goes', () => {
    const above = apply(rigged(), [
      node('n_rig_above', 'PoseLayer', { name: 'above', mode: 'override', members: [] }),
      wire(RIG, 'n_rig_above', 'pose'),
      { ...wire('n_rig_above', ARM, 'pose'), replace: true } as Op,
    ]);
    expect(poseLayerChain(graph(above), ARM).layers).toEqual(['n_rig_above', BASE]);
    expect(handPoseLayerOf(graph(above), ARM)).toBeNull();
  });
});

describe('#1357 — the gizmo does not invert through a Rig that changes the bone', () => {
  function withHandLayer(ikWeight: number): { state: DagState; layer: string } {
    useDagStore.getState().hydrate(rigged(ikWeight));
    const res = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: ARM, bone: 'goal', rotation: [0, 0, 0] },
      'pose',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return { state: live(), layer: handPoseLayerOf(graph(live()), ARM)! };
  }
  const Q: Quat = [0, 0, Math.sin(0.2), Math.cos(0.2)];

  it('a bone the Rig solves is refused, naming the Rig', () => {
    const { state, layer } = withHandLayer(1);
    const res = layerValueForDrawn(state, ARM, layer, 'lower', 'rotation', Q, T);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(
      new RegExp(`the Rig "${RIG}" above sets lower's rotation`),
    );
  });
  it('a control bone the Rig only reads still inverts, to the value drawn', () => {
    const { state, layer } = withHandLayer(1);
    expect(layerValueForDrawn(state, ARM, layer, 'goal', 'rotation', Q, T)).toEqual({
      ok: true,
      value: Q,
    });
  });
  it('with the ik inside blended to 0 the Rig hands the bone through, and it inverts again', () => {
    const { state, layer } = withHandLayer(0);
    expect(layerValueForDrawn(state, ARM, layer, 'lower', 'rotation', Q, T).ok).toBe(true);
  });
  it('a layer inside the Rig is not a layer to store a drawn pose in, and is told apart', () => {
    const { state } = withHandLayer(1);
    const inside = layerValueForDrawn(state, ARM, IK, 'goal', 'rotation', Q, T);
    expect((inside as { reason: string }).reason).toMatch(/is inside a Rig/);
    const stranger = layerValueForDrawn(state, ARM, 'n_nowhere', 'goal', 'rotation', Q, T);
    expect((stranger as { reason: string }).reason).toMatch(
      /is not in this armature's pose layers/,
    );
  });
});

describe('#1357 — renaming a bone renames it inside the Rig', () => {
  for (const [bone, field] of [
    ['lower', 'mid'],
    ['goal', 'goal'],
  ] as const) {
    it(`${bone} → the ik layer's ${field}`, () => {
      const state = rigged();
      const res = renameBone(state, ARM, bone, `${bone}_renamed`);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const next = apply(state, (res as { ops: readonly Op[] }).ops);
      expect((next.nodes[IK].params as PoseLayerParams).ik![field]).toBe(`${bone}_renamed`);
      useDagStore.getState().hydrate(next);
      expect(heads()[2].distanceTo(GOAL), 'still solves').toBeLessThan(1e-6);
    });
  }
});

describe('#1357 — a bind and a bake with a Rig on the wire', () => {
  it('a bind replaces the motion UNDER the Rig: the base is muted and the Rig keeps its place', () => {
    const state = apply(rigged(), [
      node('n_retarget', 'RetargetClip', { name: 'r', active: true }),
    ]);
    const ops = bindPosedOps(state, 'n_retarget', ARM);
    expect(ops).toEqual([
      { type: 'setParam', nodeId: BASE, paramPath: 'mute', value: true },
      {
        type: 'connect',
        from: { node: 'n_retarget', socket: 'posed' },
        to: { node: BASE, socket: 'pose' },
        replace: true,
      },
    ]);
    expect(poseLayerChain(graph(apply(state, ops)), ARM).hops[0]).toEqual({ id: RIG, kind: 'rig' });
  });

  it('a bake at a layer above the Rig is refused by name; at the layer under it, it is not', () => {
    const state = apply(rigged(), [
      node('n_rig_above', 'PoseLayer', { name: 'above', mode: 'override', members: [] }),
      wire(RIG, 'n_rig_above', 'pose'),
      { ...wire('n_rig_above', ARM, 'pose'), replace: true } as Op,
    ]);
    const args = { object: ARM, layerId: 'n_baked', poses: { kind: 'times', times: [0, 1] } };
    const above = bakePose(state, { ...args, at: 'n_rig_above' } as never);
    expect(above.ok).toBe(false);
    expect((above as { reason: string }).reason).toMatch(
      new RegExp(`the Rig “${RIG}” is under “n_rig_above”`),
    );
    const under = bakePose(state, { ...args, at: BASE } as never);
    expect((under as { reason?: string }).reason ?? '').not.toMatch(/Rig/);
  });
});

describe('#1357 — keys inside the Rig', () => {
  it('the timeline shows the rows of the layers inside, where the Rig sits', () => {
    const rows = layerChannelRows(rigged().nodes, ARM);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain(IK);
  });

  it('a key on a layer inside the Rig names a bone of the rigged skeleton, or is refused', () => {
    const state = apply(rigged(), [
      node('n_rig_fix', 'PoseLayer', { name: 'fix', mode: 'additive', members: [] }),
      // Into the body first: wired the other way round, the ik layer would for one step feed a
      // node outside its Rig, which the single-owner rule refuses.
      { ...wire('n_rig_fix', RIG, 'body'), replace: true } as Op,
      wire(IK, 'n_rig_fix', 'pose'),
    ]);
    const key = (bone: string) =>
      resolveChannelAddress(
        state,
        { layer: { layerId: 'n_rig_fix', bone, component: 'position' } },
        { mint: true },
      );
    expect(key('tip').ok, JSON.stringify(key('tip'))).toBe(true);
    expect((key('nose') as { reason: string }).reason).toMatch(/has no bone "nose" \(it has 5/);
  });
});
