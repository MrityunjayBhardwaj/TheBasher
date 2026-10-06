// #1343 — an `ik` pose layer on the wire: the solve toward a keyed control bone, its weight as the
// FK/IK switch, and the wire read at every frame while it shows.
//
// The rig: the oracle chain of `twoBoneIk.test.ts` (upper → lower → tip) plus root control bones
// `goal` and `pole`. An FK layer below keys the goal's position over a second and bends the elbow; the
// ik layer above solves toward wherever the goal is.
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SkeletonNode, SkeletonParams, type SkeletonOutputs } from './Skeleton';
import { PoseLayerNode, PoseLayerParams, poseLayerIkProblem } from './PoseLayer';
import { posedWorldMatrices } from '../viewport/boneShape';
import type { BoneSpec, PosedSkeletonValue } from './types';

const TURN = 2 * Math.atan2(0.024976602, 0.999688029);
const LEN = 1.001249194;
const BONES: BoneSpec[] = [
  { name: 'upper', parent: -1, position: [0, 0, 0], rotation: [TURN, 0, 0] },
  { name: 'lower', parent: 0, position: [0, LEN, 0], rotation: [-2 * TURN, 0, 0] },
  { name: 'tip', parent: 1, position: [0, LEN, 0], rotation: [0, 0, 0] },
  { name: 'goal', parent: -1, position: [0.8, 1.2, 0.5], rotation: [0, 0, 0] },
  { name: 'pole', parent: -1, position: [0, 1, 2], rotation: [0, 0, 0] },
];
const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
const GOAL_AT = (t: number): [number, number, number] => [
  0.8 - 0.5 * t,
  1.2 + 0.3 * t,
  0.5 - 0.9 * t,
];

function rest(): PosedSkeletonValue {
  const { pose } = SkeletonNode.evaluate(
    SkeletonParams.parse({ bones: BONES }),
    {},
    CTX,
  ) as SkeletonOutputs;
  return pose;
}

/** The FK layer: the goal keyed linearly from GOAL_AT(0) to GOAL_AT(1), the elbow bent 30° about X. */
function fk(): PosedSkeletonValue {
  return PoseLayerNode.evaluate(
    PoseLayerParams.parse({
      name: 'fk',
      members: [
        { bone: 'goal', rotationMode: 'XYZ' },
        { bone: 'lower', rotationMode: 'XYZ', rotation: [-2 * TURN * (180 / Math.PI) + 30, 0, 0] },
      ],
      channels: [
        {
          bone: 'goal',
          component: 'position',
          keyframes: [
            { time: 0, value: GOAL_AT(0), easing: 'linear' },
            { time: 1, value: GOAL_AT(1), easing: 'linear' },
          ],
        },
      ],
    }),
    { pose: rest() },
    CTX,
  ) as PosedSkeletonValue;
}

function ik(params: Record<string, unknown>, below = fk()): PosedSkeletonValue {
  return PoseLayerNode.evaluate(
    PoseLayerParams.parse({
      name: 'ik',
      mode: 'ik',
      ik: { root: 'upper', mid: 'lower', tip: 'tip', goal: 'goal', pole: 'pole' },
      ...params,
    }),
    { pose: below },
    CTX,
  ) as PosedSkeletonValue;
}

const headsAt = (wire: PosedSkeletonValue, t: number) =>
  posedWorldMatrices(BONES, wire.sample(t)).map((m) => new Vector3().setFromMatrixPosition(m));

describe('#1343 — an ik layer solves toward the keyed control bone', () => {
  it('the tip is on the goal at every frame the goal moves through', () => {
    const wire = ik({});
    for (const t of [0, 0.25, 0.5, 0.8, 1]) {
      const h = headsAt(wire, t);
      expect(h[2].distanceTo(new Vector3(...GOAL_AT(t))), `t=${t}`).toBeLessThan(1e-6);
    }
  });
  it('the FK alone leaves the tip off the goal (the solve is what moves it)', () => {
    expect(headsAt(fk(), 0.5)[2].distanceTo(new Vector3(...GOAL_AT(0.5)))).toBeGreaterThan(0.3);
  });
  it('bones outside the chain arrive untouched', () => {
    const below = fk();
    const solved = ik({}, below).sample(0.5);
    const arrived = below.sample(0.5);
    for (const name of ['tip', 'goal', 'pole']) {
      const i = BONES.findIndex((b) => b.name === name);
      expect(solved[i], name).toEqual(arrived[i]);
    }
  });
});

describe('#1343 — the weight is the FK/IK switch', () => {
  it('weight 0 reproduces the FK pose exactly', () => {
    const below = fk();
    expect(ik({ weight: 0 }, below).sample(0.5)).toEqual(below.sample(0.5));
  });
  it('a keyed weight animates the switch: FK at 0 s, IK at 1 s, between them halfway', () => {
    const below = fk();
    const wire = ik(
      {
        channels: [
          {
            component: 'weight',
            keyframes: [
              { time: 0, value: 0, easing: 'linear' },
              { time: 1, value: 1, easing: 'linear' },
            ],
          },
        ],
      },
      below,
    );
    expect(wire.sample(0)).toEqual(below.sample(0));
    expect(headsAt(wire, 1)[2].distanceTo(new Vector3(...GOAL_AT(1)))).toBeLessThan(1e-6);
    const half = headsAt(wire, 0.5)[2];
    const fkTip = headsAt(below, 0.5)[2];
    const goal = new Vector3(...GOAL_AT(0.5));
    expect(half.distanceTo(fkTip)).toBeGreaterThan(0.05);
    expect(half.distanceTo(goal)).toBeGreaterThan(0.05);
  });
});

describe('#1343 — the wire is read at every frame while the solve shows', () => {
  it('an ik layer at weight > 0 adds every frame inside the motion’s range', () => {
    const below = fk();
    const k = below.clip?.times.length ?? 0;
    const wire = ik({}, below);
    expect(wire.clip?.start).toBe(below.clip?.start);
    expect(wire.clip?.end).toBe(below.clip?.end);
    expect(wire.clip!.times.length).toBeGreaterThan(k + 30);
  });
  it('at weight 0 it adds none', () => {
    const below = fk();
    expect(ik({ weight: 0 }, below).clip?.times).toEqual(below.clip?.times);
  });
});

describe('#1343 — a layer that cannot solve hands the pose through and says why', () => {
  it('no chain, or a goal under the chain', () => {
    const below = fk();
    expect(ik({ ik: undefined }, below)).toBe(below);
    expect(poseLayerIkProblem({ mode: 'ik' }, below.skeleton)).toMatch(/no chain/);
    const bad = { root: 'upper', mid: 'lower', tip: 'tip', goal: 'tip' };
    expect(ik({ ik: bad }, below)).toBe(below);
    expect(
      poseLayerIkProblem(
        { mode: 'ik', ik: PoseLayerParams.parse({ mode: 'ik', ik: bad }).ik },
        below.skeleton,
      ),
    ).toMatch(/moves with the chain/);
  });
});
