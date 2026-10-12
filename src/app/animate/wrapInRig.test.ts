// #1357 — wrapping pose layers in a Rig: the same pose, regrouped.
//
// The rig of `ikLayerChain.test.ts`, with a full chain on the armature Object's wire:
//
//   Skeleton.pose → base (keys the goal) → hand (an FK bend) → ik → twist (additive) → Object.pose
//
// Wrapping `ik` and `twist` must leave every bone where it was at every time, through the store's
// own op-by-op checks, and leave a chain the other writers still read correctly.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { subnetworkOf, subnetworkViolations } from '../../core/dag/subnetworks';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import type { BoneSpec, ObjectValue, PosedSkeletonValue } from '../../nodes/types';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { useAutoKeyStore } from '../stores/autoKeyStore';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { handPoseLayerOf, poseLayerChain } from './poseChain';
import { freeRigIds, rigCandidateLayers, wrapInRig } from './wrapInRig';
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
const ARM = 'n_arm';
const TIMES = [0, 0.2, 0.5, 0.75, 1, 1.4];
const live = () => useDagStore.getState().state;
const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
  ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;

function chain(): DagState {
  return apply(buildDefaultDagState(), [
    node('n_skel', 'Skeleton', { bones: BONES }),
    node('base', 'PoseLayer', {
      name: 'base',
      members: [{ bone: 'goal', rotationMode: 'XYZ' }],
      channels: [
        {
          bone: 'goal',
          component: 'position',
          keyframes: [
            { time: 0, value: [0.8, 1.2, 0.5], easing: 'linear' },
            { time: 1, value: [0.2, 1.5, -0.4], easing: 'linear' },
          ],
        },
      ],
    }),
    wire('n_skel', 'base', 'pose', 'pose'),
    node('hand', 'PoseLayer', {
      name: 'hand',
      members: [{ bone: 'lower', rotationMode: 'ZYX', rotation: [0, 50, -20] }],
    }),
    wire('base', 'hand', 'pose'),
    node('ik', 'PoseLayer', {
      name: 'arm ik',
      mode: 'ik',
      ik: { root: 'upper', mid: 'lower', tip: 'tip', goal: 'goal', pole: 'pole' },
      channels: [
        {
          component: 'weight',
          keyframes: [
            { time: 0, value: 1, easing: 'linear' },
            { time: 1, value: 0.3, easing: 'linear' },
          ],
        },
      ],
    }),
    wire('hand', 'ik', 'pose'),
    node('twist', 'PoseLayer', {
      name: 'twist',
      mode: 'additive',
      members: [{ bone: 'tip', rotationMode: 'XYZ', rotation: [0, 40, 0] }],
    }),
    wire('ik', 'twist', 'pose'),
    node(ARM, 'Object'),
    wire('twist', ARM, 'pose'),
    wire('n_skel', ARM, 'data'),
  ]);
}

const drawn = (state: DagState) => {
  const v = evaluate(state, ARM).value as ObjectValue;
  const pose = (v as { pose?: PosedSkeletonValue }).pose!;
  return TIMES.map((t) => pose.sample(t));
};
const wrapArgs = (state: DagState, layers: readonly string[]) => ({
  object: ARM,
  layers,
  ...freeRigIds(state, ARM),
});
const reasonOf = (state: DagState, layers: readonly string[]) => {
  const res = wrapInRig(state, wrapArgs(state, layers));
  return res.ok ? null : res.reason;
};

describe('#1357 — wrapping layers in a Rig', () => {
  it('offers the ik layer and everything over it, top first', () => {
    expect(rigCandidateLayers(chain(), ARM)).toEqual(['twist', 'ik']);
  });

  it('through the store: the drawn pose is the same at every time, and the layers are inside', () => {
    useDagStore.getState().hydrate(chain());
    const before = drawn(live());
    // The premise: the layers being wrapped do something, so "unchanged" is not vacuous.
    expect(before).not.toEqual(
      drawn(apply(live(), [{ ...wire('hand', ARM, 'pose'), replace: true } as Op])),
    );

    const res = dispatchMutatorFromUI('mutator.animate.wrapInRig', { object: ARM }, 'wrap');
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const after = live();
    expect(drawn(after)).toEqual(before);
    const rig = `${ARM}_rig`;
    expect(after.nodes[rig]?.type).toBe('Rig');
    expect([...subnetworkOf(after, rig)].sort()).toEqual(['ik', `${ARM}_rig_in`, 'twist']);
    expect(subnetworkViolations(after)).toEqual([]);
    const walked = poseLayerChain(graph(after), ARM);
    expect(walked.hops.map((h) => h.id)).toEqual([rig, 'hand', 'base']);
    expect(walked.allLayers).toEqual(['twist', 'ik', 'hand', 'base']);
    expect(walked.base).toBe('base');
    // The layer a hand-pose lands in is the one it landed in before: under the solve.
    expect(handPoseLayerOf(graph(after), ARM)).toBe('hand');
    // Nothing left on the wire to wrap.
    expect(rigCandidateLayers(after, ARM)).toEqual([]);
  });

  it('a run in the middle of the wire: the layer above keeps reading it', () => {
    const state = chain();
    const res = wrapInRig(state, wrapArgs(state, ['ik']));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const { ops } = res as { ops: readonly Op[] };
    const after = apply(state, ops);
    expect(drawn(after)).toEqual(drawn(state));
    // Every edge the wrap displaces is one it says it displaces: no op is reported as having
    // quietly taken a socket that was in use.
    let at = state;
    const reported = ops.flatMap((op) => {
      const step = applyOp(at, op);
      at = step.next;
      return step.reportable ? [step.reportable.badge] : [];
    });
    expect(reported).toEqual([]);
    expect(poseLayerChain(graph(after), ARM).hops.map((h) => h.id)).toEqual([
      'twist',
      `${ARM}_rig`,
      'hand',
      'base',
    ]);
  });

  it('with a Rig on the wire already, offers the next run that still holds an ik layer', () => {
    // twist → Rig(ik) → hand → ik2 → base: the run under the Rig is `hand`, `ik2`.
    const state = chain();
    const once = apply(state, (wrapInRig(state, wrapArgs(state, ['ik'])) as { ops: Op[] }).ops);
    const more = apply(once, [
      node('ik2', 'PoseLayer', {
        name: 'second ik',
        mode: 'ik',
        weight: 0,
        ik: { root: 'upper', mid: 'lower', tip: 'tip', goal: 'goal' },
      }),
      wire('base', 'ik2', 'pose'),
      { ...wire('ik2', 'hand', 'pose'), replace: true } as Op,
    ]);
    expect(poseLayerChain(graph(more), ARM).hops.map((h) => h.id)).toEqual([
      'twist',
      `${ARM}_rig`,
      'hand',
      'ik2',
      'base',
    ]);
    const offered = rigCandidateLayers(more, ARM);
    expect(offered).toEqual(['hand', 'ik2']);
    expect(wrapInRig(more, wrapArgs(more, offered)).ok).toBe(true);
  });

  it('a second wrap takes free ids', () => {
    const state = chain();
    const once = apply(state, (wrapInRig(state, wrapArgs(state, ['ik'])) as { ops: Op[] }).ops);
    expect(freeRigIds(once, ARM)).toEqual({ rigId: `${ARM}_rig_2`, inputId: `${ARM}_rig_in_2` });
    const res = wrapInRig(once, wrapArgs(once, ['twist']));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(drawn(apply(once, (res as { ops: Op[] }).ops))).toEqual(drawn(state));
  });

  it('refuses, with the reason', () => {
    const state = chain();
    expect(reasonOf(state, [])).toMatch(/no layers to wrap/);
    expect(reasonOf(state, ['hand', 'base'])).toMatch(/“base” is “n_arm”’s base layer/);
    expect(reasonOf(state, ['twist', 'hand'])).toMatch(/“ik” sits between the layers/);
    expect(reasonOf(state, ['ik', 'ik'])).toMatch(/named twice/);
    expect(reasonOf(state, ['n_skel'])).toMatch(/is not a pose layer on “n_arm”’s wire/);
    expect(
      wrapInRig(state, { object: 'n_skel', layers: ['ik'], rigId: 'r', inputId: 'i' }),
    ).toEqual({
      ok: false,
      reason: '“n_skel” is not an Object',
    });
    expect(wrapInRig(state, { object: ARM, layers: ['ik'], rigId: 'hand', inputId: 'i' })).toEqual({
      ok: false,
      reason: '“hand” is taken',
    });
    const once = apply(state, (wrapInRig(state, wrapArgs(state, ['ik'])) as { ops: Op[] }).ops);
    expect(reasonOf(once, ['ik'])).toMatch(/“ik” is already inside a Rig/);
    expect(reasonOf(once, ['twist', 'hand'])).toMatch(
      /the Rig “n_arm_rig” sits between the layers/,
    );
  });
});
