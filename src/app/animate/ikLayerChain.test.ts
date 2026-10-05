// #1343 — an `ik` layer in an armature's pose chain, as the chain's writers see it.
//
// Rig: the oracle chain (upper → lower → tip) plus root control bones `goal` and `pole`, on an armature
// Object fed Skeleton.pose → base → ik. What must hold:
//   1. a hand-pose is FK: it lands BELOW the ik layer (inserted there when the chain has no layer to
//      take it), never above, where it would override the solve;
//   2. the gizmo's inversion refuses a bone the ik layer drives while its blend shows, and says why;
//      a bone it does not drive (a control bone) still inverts;
//   3. renaming a bone renames it in the ik layer's chain.
import { beforeEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import type { BoneSpec, ObjectValue, PosedSkeletonValue, Quat } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { useAutoKeyStore } from '../stores/autoKeyStore';
import { useTimeStore } from '../stores/timeStore';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { poseObjectBoneAsShown } from './autoKeyCommit';
import { poseTargetForBone, type ObjectPoseTarget } from './poseTargetForBone';
import { handPoseLayerOf, poseLayerChain } from './poseChain';
import { layerValueForDrawn } from './invertPoseStack';
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
const ARM = 'n_ik_arm';
const IK = 'n_ik_layer';
const T = 0.5;
const live = () => useDagStore.getState().state;
const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

function rig(ikWeight = 1): DagState {
  return apply(buildDefaultDagState(), [
    { type: 'addNode', nodeId: 'n_ik_skel', nodeType: 'Skeleton', params: { bones: BONES } },
    {
      type: 'addNode',
      nodeId: 'n_ik_base',
      nodeType: 'PoseLayer',
      params: { name: 'base', mode: 'override', members: [] },
    },
    {
      type: 'addNode',
      nodeId: IK,
      nodeType: 'PoseLayer',
      params: {
        name: 'arm ik',
        mode: 'ik',
        weight: ikWeight,
        ik: { root: 'upper', mid: 'lower', tip: 'tip', goal: 'goal', pole: 'pole' },
      },
    },
    { type: 'addNode', nodeId: ARM, nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: 'n_ik_skel', socket: 'pose' },
      to: { node: 'n_ik_base', socket: 'pose' },
    },
    {
      type: 'connect',
      from: { node: 'n_ik_base', socket: 'out' },
      to: { node: IK, socket: 'pose' },
    },
    { type: 'connect', from: { node: IK, socket: 'out' }, to: { node: ARM, socket: 'pose' } },
    {
      type: 'connect',
      from: { node: 'n_ik_skel', socket: 'out' },
      to: { node: ARM, socket: 'data' },
    },
  ] as Op[]);
}

function heads(): Vector3[] {
  const v = evaluate(live(), ARM, {
    ctx: { time: { frame: 0, seconds: T, normalized: 0 } } as never,
  }).value as ObjectValue;
  const pose = (v as { pose?: PosedSkeletonValue }).pose!.sample(T);
  return posedWorldMatrices(BONES, pose).map((m) => new Vector3().setFromMatrixPosition(m));
}

describe('#1343 — the rig solves (the chain the writers walk is live)', () => {
  it('the tip is on the goal', () => {
    useDagStore.getState().hydrate(rig());
    expect(heads()[2].distanceTo(new Vector3(0.8, 1.2, 0.5))).toBeLessThan(1e-6);
  });
});

describe('#1343 — a hand-pose is FK: it goes below the ik layer', () => {
  it('the walk passes through the ik layer and finds the base below', () => {
    const { layers, base } = poseLayerChain(graph(rig()), ARM);
    expect(layers).toEqual([IK, 'n_ik_base']);
    expect(base).toBe('n_ik_base');
  });

  it('posing a chain bone inserts the hand-pose layer under the ik layer', () => {
    useDagStore.getState().hydrate(rig());
    const res = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: ARM, bone: 'lower', rotation: [0, 0, 40] },
      'pose',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const { layers } = poseLayerChain(graph(live()), ARM);
    expect(layers[0]).toBe(IK);
    expect(layers).toHaveLength(3);
    expect(handPoseLayerOf(graph(live()), ARM)).toBe(layers[1]);
    // The solve still owns the drawn chain: the tip stays on the goal.
    expect(heads()[2].distanceTo(new Vector3(0.8, 1.2, 0.5))).toBeLessThan(1e-6);
  });

  it('an override layer above the ik layer is not where a hand-pose goes', () => {
    const above = apply(rig(), [
      {
        type: 'addNode',
        nodeId: 'n_ik_above',
        nodeType: 'PoseLayer',
        params: { name: 'above', mode: 'override', members: [] },
      },
      {
        type: 'connect',
        from: { node: IK, socket: 'out' },
        to: { node: 'n_ik_above', socket: 'pose' },
      },
      {
        type: 'connect',
        from: { node: 'n_ik_above', socket: 'out' },
        to: { node: ARM, socket: 'pose' },
        replace: true,
      },
    ] as Op[]);
    expect(handPoseLayerOf(graph(above), ARM)).toBeNull();
  });

  it('"pose this bone" on a goal bone the clip moves leaves the drawn rig as it was', () => {
    // The goal is keyed in the base, so it is moving; the button seeds from what arrives under the
    // layer it inserts — below the ik layer.
    const keyed = apply(rig(), [
      {
        type: 'setParam',
        nodeId: 'n_ik_base',
        paramPath: 'channels',
        value: [
          {
            bone: 'goal',
            component: 'position',
            keyframes: [
              { time: 0, value: [0.8, 1.2, 0.5], easing: 'linear' },
              { time: 1, value: [0.2, 1.5, -0.4], easing: 'linear' },
            ],
          },
        ],
      },
      {
        type: 'setParam',
        nodeId: 'n_ik_base',
        paramPath: 'members',
        value: [{ bone: 'goal', rotationMode: 'XYZ' }],
      },
    ] as Op[]);
    useDagStore.getState().hydrate(keyed);
    useTimeStore.getState().setTime(T);
    const before = heads();
    const target = poseTargetForBone(live(), ARM, 'goal', T) as ObjectPoseTarget;
    expect(target.rotation).toBeNull();
    const res = poseObjectBoneAsShown(target);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const after = heads();
    after.forEach((h, i) => expect(h.distanceTo(before[i]), BONES[i].name).toBeLessThan(1e-9));
  });
});

describe('#1343 — "pose this bone" on a chain bone seeds the FK, not the solve', () => {
  it('the drawn rig is unchanged: the new FK member equals what arrives under the ik layer', () => {
    // Bend the FK so the solve's output for `lower` differs from what arrives under it.
    const bent = apply(rig(), [
      {
        type: 'setParam',
        nodeId: 'n_ik_base',
        paramPath: 'members',
        value: [{ bone: 'lower', rotationMode: 'ZYX', rotation: [0, 50, -20] }],
      },
    ] as Op[]);
    useDagStore.getState().hydrate(bent);
    useTimeStore.getState().setTime(T);
    const before = heads();
    const res = poseObjectBoneAsShown(
      poseTargetForBone(live(), ARM, 'lower', T) as ObjectPoseTarget,
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    heads().forEach((h, i) => expect(h.distanceTo(before[i]), BONES[i].name).toBeLessThan(1e-9));
  });
});

describe('#1343 — the gizmo does not invert through a solve that drives the bone', () => {
  function withHandLayer(ikWeight: number): { state: DagState; layer: string } {
    useDagStore.getState().hydrate(rig(ikWeight));
    const res = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: ARM, bone: 'goal', rotation: [0, 0, 0] },
      'pose',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return { state: live(), layer: handPoseLayerOf(graph(live()), ARM)! };
  }
  const Q: Quat = [0, 0, Math.sin(0.2), Math.cos(0.2)];

  it('a chain bone is refused, naming the ik layer', () => {
    const { state, layer } = withHandLayer(1);
    const res = layerValueForDrawn(state, ARM, layer, 'lower', 'rotation', Q, T);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/IK layer "arm ik"/);
  });
  it('a control bone still inverts', () => {
    const { state, layer } = withHandLayer(1);
    expect(layerValueForDrawn(state, ARM, layer, 'goal', 'rotation', Q, T).ok).toBe(true);
  });
  it('with the ik blended to 0, the chain bone inverts again', () => {
    const { state, layer } = withHandLayer(0);
    expect(layerValueForDrawn(state, ARM, layer, 'lower', 'rotation', Q, T).ok).toBe(true);
  });
  it('the ik layer itself is not a layer to store a pose in', () => {
    const { state } = withHandLayer(1);
    const res = layerValueForDrawn(state, ARM, IK, 'goal', 'rotation', Q, T);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/is an IK layer/);
  });
});

describe('#1343 — renaming a bone renames it in the ik chain', () => {
  for (const [bone, field] of [
    ['lower', 'mid'],
    ['goal', 'goal'],
    ['pole', 'pole'],
  ] as const) {
    it(`${bone} → the layer's ${field}`, () => {
      const state = rig();
      const res = renameBone(state, ARM, bone, `${bone}_renamed`);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const next = apply(state, (res as { ops: readonly Op[] }).ops);
      const ik = (next.nodes[IK].params as PoseLayerParams).ik!;
      expect(ik[field]).toBe(`${bone}_renamed`);
      useDagStore.getState().hydrate(next);
      expect(heads()[2].distanceTo(new Vector3(0.8, 1.2, 0.5)), 'still solves').toBeLessThan(1e-6);
    });
  }
});
