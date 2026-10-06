// #1510 — Add › IK on a tip joint: the chain, its goal and pole, and a pose that does not move.
//
// Rig: upper → lower → tip (+ a finger under the tip), and a root control bone `ctrl`, on an armature
// Object fed Skeleton.pose → base. The base layer turns the chain and keys `lower`, so the pose drawn
// at the playhead is neither the rest nor the pose at 0 s. What must hold:
//   1. adding the IK leaves every drawn joint where it was (1e-6), the layer goes on top of the chain,
//      and the new goal sits on the drawn tip; moving the goal then moves the tip to it;
//   2. the pole is on the bend's side, and the pose holds for any root orientation (the pole angle);
//   3. it is refused by name: no parent, no grandparent, already has an IK, a joint another IK
//      solves, a straight chain with no preferred angle;
//   4. an existing goal is used, not a new one.
import { beforeEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import type { BoneSpec, ObjectValue, PosedSkeletonValue, Vec3 } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { poseLayerChain } from './poseChain';
import { posedWorldMatrices } from '../../viewport/boneShape';
import { ikLayerIdFor, planAddIk } from './addIk';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

const ARM = 'n_addik_arm';
const SKEL = 'n_addik_skel';
const BASE = 'n_addik_base';
const T = 0.75;
const live = () => useDagStore.getState().state;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

const bonesWith = (
  rootRotation: Vec3,
  lowerRest: Vec3 = [0, 0, 0.4],
  lowerAt: Vec3 = [0, 1, 0],
): BoneSpec[] => [
  { name: 'upper', parent: -1, position: [0.2, 1, -0.1], rotation: rootRotation },
  { name: 'lower', parent: 0, position: lowerAt, rotation: lowerRest },
  { name: 'tip', parent: 1, position: [0, 0.9, 0], rotation: [0, 0, 0] },
  { name: 'finger', parent: 2, position: [0, 0.2, 0], rotation: [0, 0, 0] },
  { name: 'ctrl', parent: -1, position: [1.2, 1.4, 0.6], rotation: [0, 0, 0] },
];

function rig(bones: BoneSpec[] = bonesWith([0.3, -0.5, 0.2]), keyed = true): DagState {
  return apply(buildDefaultDagState(), [
    { type: 'addNode', nodeId: SKEL, nodeType: 'Skeleton', params: { bones } },
    {
      type: 'addNode',
      nodeId: BASE,
      nodeType: 'PoseLayer',
      params: {
        name: 'base',
        mode: 'override',
        // A channel plays only on a member: `lower` is one so its keys turn it.
        members: [
          { bone: 'upper', rotationMode: 'XYZ', rotation: [10, 25, -15] },
          ...(keyed ? [{ bone: 'lower', rotationMode: 'XYZ' as const, rotation: [0, 0, 10] }] : []),
        ],
        channels: keyed
          ? [
              {
                bone: 'lower',
                component: 'rotation',
                keyframes: [
                  // The bend's axis turns from the root's Z toward its X over the clip.
                  { time: 0, value: [0, 0, 10], easing: 'linear' },
                  { time: 1, value: [60, 10, 40], easing: 'linear' },
                ],
              },
            ]
          : [],
      },
    },
    { type: 'addNode', nodeId: ARM, nodeType: 'Object', params: {} },
    { type: 'connect', from: { node: SKEL, socket: 'out' }, to: { node: ARM, socket: 'data' } },
    { type: 'connect', from: { node: SKEL, socket: 'pose' }, to: { node: BASE, socket: 'pose' } },
    { type: 'connect', from: { node: BASE, socket: 'out' }, to: { node: ARM, socket: 'pose' } },
  ] as Op[]);
}

/** Every drawn joint's head, by name, at `seconds`. */
function drawn(seconds = T): Map<string, Vector3> {
  const v = evaluate(live(), ARM, {
    ctx: { time: { frame: 0, seconds, normalized: 0 } } as never,
  }).value as ObjectValue;
  const posed = (v as { pose?: PosedSkeletonValue }).pose!;
  const bones = posed.skeleton.bones;
  const world = posedWorldMatrices(bones, posed.sample(seconds));
  return new Map(bones.map((b, i) => [b.name, new Vector3().setFromMatrixPosition(world[i])]));
}

const addIk = (spec: Record<string, unknown>) =>
  dispatchMutatorFromUI('mutator.rig.addIk', { object: ARM, time: T, ...spec }, 'add ik');

const maxMove = (before: Map<string, Vector3>, after: Map<string, Vector3>) =>
  Math.max(...[...before].map(([name, at]) => at.distanceTo(after.get(name)!)));

describe('#1510 — Add › IK leaves the drawn pose where it was', () => {
  it('every joint stays within 1e-6, the layer is on top, the goal is on the tip', () => {
    useDagStore.getState().hydrate(rig());
    const before = drawn();
    const res = addIk({ bone: 'tip' });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const after = drawn();
    expect(maxMove(before, after)).toBeLessThan(1e-6);

    const { layers } = poseLayerChain(live().nodes, ARM);
    const layerId = ikLayerIdFor(ARM, 'tip');
    expect(layers).toEqual([layerId, BASE]);
    const params = live().nodes[layerId].params as PoseLayerParams;
    expect(params.mode).toBe('ik');
    expect(params.weight).toBe(1);
    expect(params.ik).toMatchObject({
      root: 'upper',
      mid: 'lower',
      tip: 'tip',
      goal: 'tip_ik_goal',
      pole: 'tip_ik_pole',
    });
    expect(after.get('tip_ik_goal')!.distanceTo(before.get('tip')!)).toBeLessThan(1e-9);
    // Both control bones are roots: the chain's FK never carries them.
    const bones = (live().nodes[SKEL].params as { bones: BoneSpec[] }).bones;
    for (const name of ['tip_ik_goal', 'tip_ik_pole']) {
      expect(bones.find((b) => b.name === name)!.parent).toBe(-1);
    }
  });

  it('at other times the solve reads the FK under it (the goal stays put, the tip reaches it)', () => {
    useDagStore.getState().hydrate(rig());
    // The fixture's keys move the tip between 0 s and the playhead, so placing at 0 s is not placing.
    expect(drawn(0).get('tip')!.distanceTo(drawn().get('tip')!)).toBeGreaterThan(0.1);
    expect(addIk({ bone: 'tip' }).ok).toBe(true);
    const at0 = drawn(0);
    expect(at0.get('tip')!.distanceTo(at0.get('tip_ik_goal')!)).toBeLessThan(1e-6);
  });

  it('moving the goal bone moves the tip to it', () => {
    useDagStore.getState().hydrate(rig());
    expect(addIk({ bone: 'tip' }).ok).toBe(true);
    const goal = drawn().get('tip_ik_goal')!;
    const to: Vec3 = [goal.x - 0.3, goal.y - 0.2, goal.z + 0.1];
    const res = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: ARM, bone: 'tip_ik_goal', position: to },
      'move goal',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const after = drawn();
    expect(after.get('tip')!.distanceTo(new Vector3(...to))).toBeLessThan(1e-6);
    // The hand-pose went BELOW the ik layer, where the solve reads it.
    expect(poseLayerChain(live().nodes, ARM).layers[0]).toBe(ikLayerIdFor(ARM, 'tip'));
  });
});

describe('#1510 — the pole', () => {
  it('sits in front of the elbow, on the bend side, as far as root to tip', () => {
    useDagStore.getState().hydrate(rig());
    const before = drawn();
    expect(addIk({ bone: 'tip' }).ok).toBe(true);
    const after = drawn();
    const [A, B, C, P] = ['upper', 'lower', 'tip', 'tip_ik_pole'].map((n) => after.get(n)!);
    const line = C.clone().sub(A).normalize();
    const across = (v: Vector3) => {
      const d = v.clone().sub(A);
      return d.sub(line.clone().multiplyScalar(d.dot(line)));
    };
    // The same side of the root→tip line as the elbow, in the chain's plane.
    expect(across(P).normalize().dot(across(B).normalize())).toBeGreaterThan(1 - 1e-9);
    expect(P.distanceTo(B)).toBeCloseTo(C.distanceTo(A), 9);
    expect(maxMove(before, after)).toBeLessThan(1e-6);
  });

  it('the pose holds for any root orientation and bend plane (the solved pole angle)', () => {
    // A fixed spread of root turns and elbow bends, each axis through a full range: the bend is not
    // about the root's own Z, so a pole angle of 0 would swing the elbow. The mid joint sits along the
    // root's +Y, −Y or +X: an imported joint need not point its +Y at its child.
    const angles: number[] = [];
    const childAt: Vec3[] = [
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
    ];
    for (let i = 0; i < 36; i++) {
      const root: Vec3 = [Math.sin(i * 1.7) * 3, Math.cos(i * 2.3) * 3, Math.sin(i * 0.9 + 1) * 3];
      const bend: Vec3 = [Math.sin(i * 1.3 + 2) * 1.2, Math.cos(i * 0.7) * 1.2, 0.3];
      useDagStore.getState().hydrate(rig(bonesWith(root, bend, childAt[i % 3]), false));
      const before = drawn();
      const res = addIk({ bone: 'tip' });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(
        maxMove(before, drawn()),
        `root ${root.join(', ')}, bend ${bend.join(', ')}`,
      ).toBeLessThan(1e-6);
      const ik = (live().nodes[ikLayerIdFor(ARM, 'tip')].params as PoseLayerParams).ik!;
      angles.push(ik.poleAngle);
    }
    // The spread reaches angles a fixed choice could not: not all 0, not all one value.
    expect(Math.max(...angles.map(Math.abs))).toBeGreaterThan(30);
  });

  it('a straight chain bends by its preferred angle, and still holds', () => {
    const bones = bonesWith([0.3, -0.5, 0.2], [0, 0, 0]).map((b) =>
      b.name === 'lower' ? { ...b, preferredAngle: [0.5, 0, 0] as Vec3 } : b,
    );
    useDagStore.getState().hydrate(rig(bones, false));
    const before = drawn();
    expect(addIk({ bone: 'tip' }).ok).toBe(true);
    expect(maxMove(before, drawn())).toBeLessThan(1e-6);
  });
});

describe('#1510 — refused by name', () => {
  const reasonOf = (spec: Record<string, unknown>, state: DagState = rig()) => {
    const plan = planAddIk(state, { object: ARM, seconds: T, ...spec } as never);
    return plan.ok ? null : plan.reason;
  };

  it('a root, or a bone whose parent is a root', () => {
    expect(reasonOf({ bone: 'upper' })).toMatch(/"upper" has no parent/);
    expect(reasonOf({ bone: 'lower' })).toMatch(/"upper", the parent of "lower", has no parent/);
  });

  it('a bone that already has an IK, and a joint another IK solves', () => {
    useDagStore.getState().hydrate(rig());
    expect(addIk({ bone: 'tip' }).ok).toBe(true);
    expect(reasonOf({ bone: 'tip' }, live())).toMatch(/"tip" already has an IK/);
    expect(reasonOf({ bone: 'finger' }, live())).toMatch(/"lower" is already solved by the IK/);
    const res = addIk({ bone: 'tip' });
    expect(res.ok).toBe(false);
  });

  it('a straight chain with no preferred angle', () => {
    const straight = rig(bonesWith([0, 0, 0], [0, 0, 0]), false);
    const flat = apply(straight, [
      { type: 'setParam', nodeId: BASE, paramPath: 'members', value: [] },
    ] as Op[]);
    expect(reasonOf({ bone: 'tip' }, flat)).toMatch(/is straight.*preferred angle/);
  });

  it('a goal that is not on the rig, or is a joint of the chain', () => {
    expect(reasonOf({ bone: 'tip', goal: 'nope' })).toMatch(/no bone "nope"/);
    expect(reasonOf({ bone: 'tip', goal: 'lower' })).toMatch(/joint of the chain/);
    expect(reasonOf({ bone: 'tip', goal: 'finger' })).toMatch(/moves with the chain/);
  });
});

describe('#1510 — an existing goal', () => {
  it('is used as the goal, and only a pole is added', () => {
    useDagStore.getState().hydrate(rig());
    const count = (live().nodes[SKEL].params as { bones: BoneSpec[] }).bones.length;
    expect(addIk({ bone: 'tip', goal: 'ctrl' }).ok).toBe(true);
    const bones = (live().nodes[SKEL].params as { bones: BoneSpec[] }).bones;
    expect(bones.map((b) => b.name).slice(count)).toEqual(['tip_ik_pole']);
    const after = drawn();
    expect(after.get('tip')!.distanceTo(after.get('ctrl')!)).toBeLessThan(1e-6);
  });
});
