// #1357 — the Rig: layers wrapped in a Rig pose exactly as the same layers wired straight.
//
// The rig is the one `PoseLayerIk.test.ts` solves: upper → lower → tip, with root control bones
// `goal` and `pole`. The ANIMATION (a base layer keying the goal and bending the elbow) stays
// outside; the RIG LOGIC (the ik solve, then an additive layer on top of it) is what gets wrapped.
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAllNodes } from './registerAll';
import { z } from 'zod';
import {
  __resetRegistryForTests,
  applyOp,
  createEvaluatorCache,
  evaluate,
  registerNodeType,
} from '../core/dag';
import type { DagState } from '../core/dag/state';
import { emptyDagState } from '../core/dag/state';
import { DEPTH_LIMIT } from '../core/dag/evaluator';
import { bodyInputChoicesOf, subnetworkOf } from '../core/dag/subnetworks';
import type { Op } from '../core/dag/types';
import type { BoneSpec, PosedSkeletonValue } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
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
const TIMES = [0, 0.1, 0.25, 0.5, 0.8, 1, 1.5];

const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op => ({
  type: 'connect',
  from: { node: from, socket: fromSocket },
  to: { node: to, socket },
});

const goalKeys = (to: [number, number, number]) => [
  {
    bone: 'goal',
    component: 'position',
    keyframes: [
      { time: 0, value: [0.8, 1.2, 0.5], easing: 'linear' },
      { time: 1, value: to, easing: 'linear' },
    ],
  },
];

/** Skeleton `sk` → the animation `anim`: the goal keyed over a second, the elbow bent 30°. */
const ANIMATION: Op[] = [
  node('sk', 'Skeleton', { bones: BONES }),
  node('anim', 'PoseLayer', {
    name: 'anim',
    members: [
      { bone: 'goal', rotationMode: 'XYZ' },
      { bone: 'lower', rotationMode: 'XYZ', rotation: [-2 * TURN * (180 / Math.PI) + 30, 0, 0] },
    ],
    channels: goalKeys([0.3, 1.5, -0.4]),
  }),
  wire('sk', 'anim', 'pose', 'pose'),
];

/** The rig logic, reading `from`: an ik solve at a keyed weight, then an additive twist of the tip. */
const logic = (from: string, p = ''): Op[] => [
  node(`${p}ik`, 'PoseLayer', {
    name: 'ik',
    mode: 'ik',
    ik: { root: 'upper', mid: 'lower', tip: 'tip', goal: 'goal', pole: 'pole' },
    channels: [
      {
        component: 'weight',
        keyframes: [
          { time: 0, value: 1, easing: 'linear' },
          { time: 1, value: 0.25, easing: 'linear' },
        ],
      },
    ],
  }),
  wire(from, `${p}ik`, 'pose'),
  node(`${p}twist`, 'PoseLayer', {
    name: 'twist',
    mode: 'additive',
    members: [{ bone: 'tip', rotationMode: 'XYZ', rotation: [0, 40, 0] }],
  }),
  wire(`${p}ik`, `${p}twist`, 'pose'),
];

const unwrapped = (): DagState => apply(emptyDagState(), [...ANIMATION, ...logic('anim')]);

/** The same logic behind a Rig. The body is wired BEFORE the pose, so the order the Rig's inputs
 *  were connected in cannot be what binds the leaf. */
const wrapped = (): DagState =>
  apply(emptyDagState(), [
    ...ANIMATION,
    node('in', 'BodyInputPose'),
    ...logic('in'),
    node('rig', 'Rig'),
    wire('twist', 'rig', 'body'),
    wire('anim', 'rig', 'pose'),
  ]);

const pose = (state: DagState, id: string, opts: Parameters<typeof evaluate>[2] = {}) =>
  evaluate(state, id, opts).value as PosedSkeletonValue;
const samples = (v: PosedSkeletonValue) => TIMES.map((t) => v.sample(t));

describe('#1357 — a Rig poses exactly as the layers inside it wired straight', () => {
  it('the premise: the logic changes the pose, and the two graphs differ only by the Rig', () => {
    const s = unwrapped();
    expect(samples(pose(s, 'twist'))).not.toEqual(samples(pose(s, 'anim')));
    expect([...subnetworkOf(wrapped(), 'rig')].sort()).toEqual(['ik', 'in', 'twist']);
  });

  it('wrapped equals unwrapped: every bone at every time, the range, the skeleton', () => {
    const plain = pose(unwrapped(), 'twist');
    const rigged = pose(wrapped(), 'rig');
    expect(samples(rigged)).toEqual(samples(plain));
    expect(rigged.clip).toEqual(plain.clip);
    expect(rigged.skeleton).toEqual(plain.skeleton);
    expect(rigged.soloed).toEqual(plain.soloed);
    expect(samples(rigged.source!)).toEqual(samples(plain.source!));
  });

  it('the leaf is the incoming pose itself, not a copy', () => {
    const s = wrapped();
    const cache = createEvaluatorCache();
    const incoming = pose(s, 'anim', { cache });
    // A layer that touches nothing hands its input back by reference, so the leaf shows through.
    const through = apply(s, [
      node('idle', 'PoseLayer', { name: 'idle' }),
      {
        type: 'disconnect',
        from: { node: 'in', socket: 'out' },
        to: { node: 'ik', socket: 'pose' },
      },
      wire('in', 'idle', 'pose'),
      wire('idle', 'ik', 'pose'),
      node('r2', 'Rig'),
      node('in2', 'BodyInputPose'),
      node('idle2', 'PoseLayer', { name: 'idle2' }),
      wire('in2', 'idle2', 'pose'),
      wire('idle2', 'r2', 'body'),
      wire('anim', 'r2', 'pose'),
    ]);
    expect(pose(through, 'r2', { cache })).toBe(incoming);
  });

  it('an empty Rig hands its pose through', () => {
    const s = apply(emptyDagState(), [
      ...ANIMATION,
      node('rig', 'Rig'),
      wire('anim', 'rig', 'pose'),
    ]);
    const cache = createEvaluatorCache();
    expect(pose(s, 'rig', { cache })).toBe(pose(s, 'anim', { cache }));
  });

  it('a change to the incoming pose reaches the sub-network through a shared cache', () => {
    const cache = createEvaluatorCache();
    const before = wrapped();
    const first = samples(pose(before, 'rig', { cache }));
    // Same skeleton, same nodes inside the Rig; only the animation outside it moved the goal.
    const after = apply(before, [
      {
        type: 'setParam',
        nodeId: 'anim',
        paramPath: 'channels',
        value: goalKeys([1.1, 0.4, 0.9]),
      } as Op,
    ]);
    const second = samples(pose(after, 'rig', { cache }));
    expect(second).not.toEqual(first);
    const plain = apply(unwrapped(), [
      {
        type: 'setParam',
        nodeId: 'anim',
        paramPath: 'channels',
        value: goalKeys([1.1, 0.4, 0.9]),
      } as Op,
    ]);
    expect(second).toEqual(samples(pose(plain, 'twist')));
  });

  it('a leaf naming an input the Rig does not declare is not bound', () => {
    const s = wrapped();
    const renamed = apply(s, [
      { type: 'setParam', nodeId: 'in', paramPath: 'input', value: 'nope' } as Op,
    ]);
    // Evaluated first on the good graph, so a binding remembered across states would show here.
    expect(pose(s, 'rig').skeleton.bones).toHaveLength(BONES.length);
    expect(pose(renamed, 'rig').skeleton.bones).toHaveLength(0);
    expect(bodyInputChoicesOf(s, 'in')).toEqual({ owners: ['rig'], names: ['pose'] });
  });

  it('a node inside a Rig, asked on its own, reads what it reads through the Rig', () => {
    // What the inspector does when a layer inside is selected: it evaluates that layer, not the Rig.
    const s = wrapped();
    const cache = createEvaluatorCache();
    expect(pose(s, 'in', { cache })).toBe(pose(s, 'anim', { cache }));
    expect(samples(pose(s, 'twist'))).toEqual(samples(pose(s, 'rig')));
    expect(samples(pose(s, 'ik'))).toEqual(samples(pose(unwrapped(), 'ik')));
  });

  it('a leaf no Rig holds reads no pose', () => {
    const s = apply(wrapped(), [
      {
        type: 'disconnect',
        from: { node: 'twist', socket: 'out' },
        to: { node: 'rig', socket: 'body' },
      },
    ] as Op[]);
    expect(pose(s, 'in').skeleton.bones).toHaveLength(0);
    expect(pose(s, 'twist').sample(0)).toEqual([]);
  });

  it('a sub-network deeper than the chain feeding it is counted from its Rig', () => {
    // More layers under the Rig and inside it than one walk may descend in a row (#1576): the
    // Rig must not make its body pay for the chain below it.
    const EACH = Math.ceil(DEPTH_LIMIT * 0.6);
    const idle = (id: string, from: string, fromSocket = 'out'): Op[] => [
      node(id, 'PoseLayer', { name: id }),
      wire(from, id, 'pose', fromSocket),
    ];
    const ops: Op[] = [node('sk', 'Skeleton', { bones: BONES })];
    let at = 'sk';
    for (let i = 0; i < EACH; i++) {
      ops.push(...idle(`a${i}`, at, i === 0 ? 'pose' : 'out'));
      at = `a${i}`;
    }
    const below = at;
    ops.push(node('in', 'BodyInputPose'));
    at = 'in';
    for (let i = 0; i < EACH; i++) {
      ops.push(...idle(`b${i}`, at));
      at = `b${i}`;
    }
    ops.push(node('rig', 'Rig'), wire(at, 'rig', 'body'), wire(below, 'rig', 'pose'));
    const s = apply(emptyDagState(), ops);
    expect(pose(s, 'rig').skeleton.bones).toHaveLength(BONES.length);
  });

  it('a stateful owner is left to its seam: the evaluator binds nothing for it', () => {
    // A stateful owner with a socket named like one of its sub-network inputs. Its seam decides
    // what `input` is each frame, so the evaluator must not resolve the leaf to that socket's
    // producer as it does for a Rig: asked on its own, the leaf reads its default. (The owner
    // itself is answered by its replay, #1558; this type has none, which is its own error.)
    const NUMBER = { type: 'Number', cardinality: 'single' } as const;
    registerNodeType({
      type: 'Seven',
      version: 1,
      pure: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      inputs: {},
      outputs: { out: NUMBER },
      evaluate: () => 7,
    } as never);
    registerNodeType({
      type: 'SeamOwned',
      version: 1,
      pure: false,
      stateful: true,
      cost: 'cheap',
      paramSchema: z.object({}),
      inputs: { input: NUMBER, body: { ...NUMBER, body: true } },
      outputs: { out: NUMBER },
      bodyInputs: { input: NUMBER },
      evaluate: (_p: unknown, inputs: Record<string, unknown>) => inputs.body,
    } as never);
    const s = apply(emptyDagState(), [
      node('seven', 'Seven'),
      node('leaf', 'BodyInput', { input: 'input' }),
      node('owner', 'SeamOwned'),
      wire('leaf', 'owner', 'body'),
      wire('seven', 'owner', 'input'),
    ]);
    expect(evaluate(s, 'seven').value).toBe(7);
    expect(evaluate(s, 'leaf').value).toBe(0);
    expect(() => evaluate(s, 'owner')).toThrow(/no replay for stateful type SeamOwned/);
  });

  it('a Rig inside a Rig: each leaf reads its own Rig', () => {
    // outer: leaf `oin` → inner Rig (ik) → twist → outer.body
    const s = apply(emptyDagState(), [
      ...ANIMATION,
      node('oin', 'BodyInputPose'),
      node('iin', 'BodyInputPose'),
      ...logic('iin', 'i.').slice(0, 2),
      node('inner', 'Rig'),
      wire('i.ik', 'inner', 'body'),
      wire('oin', 'inner', 'pose'),
      logic('inner')[2],
      wire('inner', 'twist', 'pose'),
      node('outer', 'Rig'),
      wire('twist', 'outer', 'body'),
      wire('anim', 'outer', 'pose'),
    ] as Op[]);
    expect(samples(pose(s, 'outer'))).toEqual(samples(pose(unwrapped(), 'twist')));
  });
});
