// #1344 — joint limits against Blender 5.1.1, on one rig.
//
// The oracle: headless Blender 5.1.1 (`Blender -b --factory-startup`), an armature with `upper`
// (0,0,0)→(0,1,0.2) and `fore` (0,1,0.2)→(0,2,0) connected, roll 0; rest elbow -22.62° about X. Limits
// set on `fore`. Printed by one script, the forearm's rotation relative to its rest (XYZ euler, °):
//
//   IK, chain 2, goal (0,0.6,0), 500 iterations:
//     no limit        → X -123.159, tip on the goal
//     IK limit X [-10,30] → X -10.0, tip (0, 1.9575, -0.0151): 1.3576 short, 0.015 off the goal line
//     IK limit X [-30,10] → X -30.0, tip (0, 1.8283, -0.0144)
//   IK, goal (0,1.2,0), pole (0,0.6,-3) at pole angle 90:
//     no limit        → X -85.291
//     IK limit X [0,150]  → X 0.0, tip 0.8 short (the bend does not flip to the allowed side)
//   By hand (no IK), X set to 80 / -80:
//     IK limit X [-10,30]            → drawn 80 / -80 (an IK limit does not bind a hand pose)
//     Limit Rotation, Local, X [-10,30] → drawn 30 / -10, stored 80 / -80
//     the same, X keyed 0 → 80 over 10 frames → drawn 0, 30, 30 at frames 1, 6, 11
//   IK stiffness 0 / 0.5 / 0.99 on `fore`, reachable goal: the elbow stays put to 1e-4 and only the
//     solver's shortfall grows (1e-4 → 1.1e-2). Nothing for a closed-form two-bone solve to copy.
//
// Blender's solver stops about 1e-4 short, so its angles are compared at 0.02°.
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { quatFromEulerXYZ, restBonePose, eulerXYZFromQuat } from './bonePose';
import { posedWorldMatrices } from '../viewport/boneShape';
import { solveTwoBoneIk, type IkChain } from './twoBoneIk';
import {
  clampAngle,
  clampPoseToLimits,
  clampToLimits,
  limitedBones,
  limitsProblem,
} from './jointLimits';
import { SkeletonNode, SkeletonParams, type SkeletonOutputs } from './Skeleton';
import { PoseLayerNode, PoseLayerParams } from './PoseLayer';
import type { BonePose, BoneSpec, PosedSkeletonValue, Quat } from './types';

const DEG = Math.PI / 180;
const BEND = Math.atan2(0.2, 1); // upper leans 11.31° from +Y toward +Z
const LEN = Math.hypot(1, 0.2);

type Limits = NonNullable<BoneSpec['limits']>;
const rig = (fore?: Limits, upper?: Limits, goal: [number, number, number] = [0, 0.6, 0]) =>
  [
    {
      name: 'upper',
      parent: -1,
      position: [0, 0, 0],
      rotation: [BEND, 0, 0],
      ...(upper ? { limits: upper } : {}),
    },
    {
      name: 'fore',
      parent: 0,
      position: [0, LEN, 0],
      rotation: [-2 * BEND, 0, 0],
      ...(fore ? { limits: fore } : {}),
    },
    { name: 'tip', parent: 1, position: [0, LEN, 0], rotation: [0, 0, 0] },
    { name: 'goal', parent: -1, position: goal, rotation: [0, 0, 0] },
    { name: 'pole', parent: -1, position: [0, 0.6, -3], rotation: [0, 0, 0] },
  ] as BoneSpec[];

const CHAIN: IkChain = {
  root: 'upper',
  mid: 'fore',
  tip: 'tip',
  goal: 'goal',
  poleAngle: 0,
  stretch: false,
  orientTip: false,
};

/** A bone's turn from its rest, XYZ euler degrees. */
function fromRest(bone: BoneSpec, q: Quat): number[] {
  const rest = quatFromEulerXYZ(bone.rotation);
  const rel = new Quaternion(...rest).invert().multiply(new Quaternion(...q));
  return eulerXYZFromQuat([rel.x, rel.y, rel.z, rel.w]).map((r) => r / DEG);
}
const heads = (bones: readonly BoneSpec[], pose: readonly BonePose[]) =>
  posedWorldMatrices(bones, pose).map((m) => new Vector3().setFromMatrixPosition(m));
const solved = (bones: BoneSpec[], chain = CHAIN) => {
  const out = solveTwoBoneIk(bones, bones.map(restBonePose), chain);
  expect(out, 'the chain must solve').not.toBeNull();
  return out!;
};
const range = (min: number, max: number) => [min * DEG, max * DEG] as const;

describe('#1344 — an angle is clamped on the circle', () => {
  it('inside stays, outside goes to the nearer end', () => {
    expect(clampAngle(0.2, -1, 1)).toBe(0.2);
    expect(clampAngle(1.5, -1, 1)).toBeCloseTo(1, 12);
    expect(clampAngle(-1.5, -1, 1)).toBeCloseTo(-1, 12);
  });
  it('the nearer end is the one the short way round, across ±180°', () => {
    // Range [100°, 170°]; -175° is 15° past 170° going round, 85° short of 100° the other way.
    expect(clampAngle(-175 * DEG, 100 * DEG, 170 * DEG) / DEG).toBeCloseTo(170 - 360, 9);
    // -100° is 90° from 170° going round and 160° from 100°; a plain numeric clamp answers 100°.
    expect(clampAngle(-100 * DEG, 100 * DEG, 170 * DEG) / DEG).toBeCloseTo(170 - 360, 9);
    // 20° is nearer the low end, with no wrap.
    expect(clampAngle(20 * DEG, 100 * DEG, 170 * DEG) / DEG).toBeCloseTo(100, 9);
  });
  it('a range with no width holds the angle at it (a locked axis)', () => {
    expect(clampAngle(0.7, 0, 0)).toBe(0);
  });
});

describe('#1344 — a limit is measured from the bone’s rest, in its own axes', () => {
  const fore = rig({ x: range(-10, 30) })[1];
  const turned = (deg: [number, number, number]): Quat => {
    const rest = new Quaternion(...quatFromEulerXYZ(fore.rotation));
    const q = rest.multiply(
      new Quaternion(...quatFromEulerXYZ(deg.map((d) => d * DEG) as [number, number, number])),
    );
    return [q.x, q.y, q.z, q.w];
  };
  it('the rest itself is inside (the fixture’s rest is not the identity)', () => {
    expect(Math.abs(fore.rotation[0]) / DEG).toBeGreaterThan(20);
    const rest = quatFromEulerXYZ(fore.rotation);
    expect(clampToLimits(fore, rest)).toBe(rest);
  });
  it('80° draws as 30° and -80° as -10°, as Blender’s Limit Rotation does', () => {
    expect(fromRest(fore, clampToLimits(fore, turned([80, 0, 0])))[0]).toBeCloseTo(30, 9);
    expect(fromRest(fore, clampToLimits(fore, turned([-80, 0, 0])))[0]).toBeCloseTo(-10, 9);
  });
  it('an axis without a limit is left as it was', () => {
    const held = fromRest(fore, clampToLimits(fore, turned([80, 25, -40])));
    expect(held[0]).toBeCloseTo(30, 9);
    expect(held[1]).toBeCloseTo(25, 9);
    expect(held[2]).toBeCloseTo(-40, 9);
  });
  it('a rotation inside the limits comes back as the same array', () => {
    const q = turned([12, 60, -70]);
    expect(clampToLimits(fore, q)).toBe(q);
  });
  it('a pose without a limited bone outside comes back as the same array', () => {
    const bones = rig({ x: range(-10, 30) });
    const pose = bones.map(restBonePose);
    expect(limitedBones(bones)).toEqual([1]);
    expect(clampPoseToLimits(bones, pose, limitedBones(bones))).toBe(pose);
    expect(limitedBones(rig())).toEqual([]);
  });
  it('the Skeleton refuses a range that cannot hold, whoever writes it', () => {
    const bone = { name: 'b', parent: -1 };
    expect(
      SkeletonParams.safeParse({ bones: [{ ...bone, limits: { x: [0.1, 0.5] } }] }).success,
    ).toBe(true);
    expect(
      SkeletonParams.safeParse({ bones: [{ ...bone, limits: { x: [0.5, 0.1] } }] }).success,
    ).toBe(false);
    expect(SkeletonParams.safeParse({ bones: [{ ...bone, limits: { x: [-4, 0] } }] }).success).toBe(
      false,
    );
    expect(SkeletonParams.safeParse({ bones: [{ ...bone, limits: { x: [0, 4] } }] }).success).toBe(
      false,
    );
  });

  it('a limit that cannot be stored says why', () => {
    expect(limitsProblem({ x: [0.5, 0.1] })).toMatch(/minimum is above/);
    expect(limitsProblem({ z: [-4, 1] })).toMatch(/half turn/);
    expect(limitsProblem({ y: [-1, 1] })).toBeNull();
  });
});

describe('#1344 — the IK solve stops at the elbow’s limit, where Blender’s does', () => {
  it('unlimited, the fixture needs a fold far past any limit below (-123.159° in Blender)', () => {
    const bones = rig();
    const out = solved(bones);
    expect(fromRest(bones[1], out[1].quaternion)[0]).toBeCloseTo(-123.159, 1);
    expect(heads(bones, out)[2].distanceTo(new Vector3(0, 0.6, 0))).toBeLessThan(1e-9);
  });

  for (const [min, max, at, tipY] of [
    [-10, 30, -10, 1.9575],
    [-30, 10, -30, 1.8283],
  ] as const) {
    it(`limit [${min}°, ${max}°]: the forearm stops at ${at}° and the tip falls short on the goal line`, () => {
      const bones = rig({ x: range(min, max) });
      const out = solved(bones);
      expect(fromRest(bones[1], out[1].quaternion)[0]).toBeCloseTo(at, 9);
      const tip = heads(bones, out)[2];
      // Blender's tip sits 0.015 off the line to the goal after 500 iterations; this one is on it.
      expect(Math.hypot(tip.x, tip.z)).toBeLessThan(1e-9);
      expect(tip.y).toBeCloseTo(tipY, 3);
    });
  }

  it('a pole on the forbidden side leaves the joint at its limit: the bend does not flip', () => {
    const chain = { ...CHAIN, pole: 'pole', poleAngle: 90 };
    const free = rig(undefined, undefined, [0, 1.2, 0]);
    expect(fromRest(free[1], solved(free, chain)[1].quaternion)[0]).toBeCloseTo(-85.291, 1);
    const bones = rig({ x: range(0, 150) }, undefined, [0, 1.2, 0]);
    const out = solved(bones, chain);
    expect(fromRest(bones[1], out[1].quaternion)[0]).toBeCloseTo(0, 9);
    // Blender: 0.8 short of the goal, the chain held in its rest shape (2 long) along the goal line.
    expect(heads(bones, out)[2].distanceTo(new Vector3(0, 1.2, 0))).toBeCloseTo(0.8, 6);
  });

  it('the root’s own limit holds too, and the mid joint keeps its solved bend', () => {
    const goal: [number, number, number] = [0, 0.3, 1.8];
    const free = rig(undefined, undefined, goal);
    const freeOut = solved(free);
    const turn = fromRest(free[0], freeOut[0].quaternion)[0];
    expect(Math.abs(turn), 'the fixture must turn the root past the limit').toBeGreaterThan(20);
    const bones = rig(undefined, { x: range(-5, 5) }, goal);
    const out = solved(bones);
    expect(fromRest(bones[0], out[0].quaternion)[0]).toBeCloseTo(Math.sign(turn) * 5, 9);
    expect(out[1].quaternion).toEqual(freeOut[1].quaternion);
  });

  it('a limit the solve stays inside changes nothing', () => {
    const goal: [number, number, number] = [0, 1.7, 0.3];
    const a = solved(rig(undefined, undefined, goal));
    const b = solved(rig({ x: range(-150, 150) }, { x: range(-150, 150) }, goal));
    expect(b[0].quaternion).toEqual(a[0].quaternion);
    expect(b[1].quaternion).toEqual(a[1].quaternion);
  });

  it('with orient tip, the tip still takes the goal’s rotation under the held chain', () => {
    const bones = rig({ x: range(-10, 30) });
    bones[3] = { ...bones[3], rotation: [0.3, 0.5, -0.2] };
    const out = solved(bones, { ...CHAIN, orientTip: true });
    const world = posedWorldMatrices(bones, out);
    const tip = new Quaternion().setFromRotationMatrix(world[2]);
    const goal = new Quaternion().setFromRotationMatrix(world[3]);
    expect(tip.angleTo(goal)).toBeLessThan(1e-6);
  });
});

describe('#1344 — a pose layer hands on a pose inside the limits', () => {
  const CTX = { time: { frame: 0, seconds: 0, normalized: 0 } };
  const REST_X = (-2 * BEND) / DEG;
  const restWire = (bones: BoneSpec[]): PosedSkeletonValue =>
    (SkeletonNode.evaluate(SkeletonParams.parse({ bones }), {}, CTX) as SkeletonOutputs).pose;
  const layer = (params: Record<string, unknown>, below: PosedSkeletonValue) =>
    PoseLayerNode.evaluate(
      PoseLayerParams.parse({ name: 'hand', ...params }),
      { pose: below },
      CTX,
    ) as PosedSkeletonValue;
  const LIMITED = rig({ x: range(-10, 30) });
  const foreAt = (wire: PosedSkeletonValue, t: number) =>
    fromRest(LIMITED[1], wire.sample(t)[1].quaternion)[0];

  it('a hand pose past the limit draws at the limit (Blender: 80 → 30, -80 → -10)', () => {
    for (const [set, drawn] of [
      [80, 30],
      [-80, -10],
      [12, 12],
    ]) {
      const wire = layer(
        { members: [{ bone: 'fore', rotationMode: 'XYZ', rotation: [REST_X + set, 0, 0] }] },
        restWire(LIMITED),
      );
      expect(foreAt(wire, 0)).toBeCloseTo(drawn, 9);
    }
  });

  it('without a limit the same pose draws as set (the fixture really turns the bone)', () => {
    const free = rig();
    const wire = layer(
      { members: [{ bone: 'fore', rotationMode: 'XYZ', rotation: [REST_X + 80, 0, 0] }] },
      restWire(free),
    );
    expect(fromRest(free[1], wire.sample(0)[1].quaternion)[0]).toBeCloseTo(80, 9);
  });

  it('a key curve past the limit plays clamped (Blender: 0, 40, 80 → 0, 30, 30)', () => {
    const wire = layer(
      {
        members: [{ bone: 'fore', rotationMode: 'XYZ' }],
        channels: [
          {
            bone: 'fore',
            component: 'rotation',
            keyframes: [
              { time: 0, value: [REST_X, 0, 0], easing: 'linear' },
              { time: 1, value: [REST_X + 80, 0, 0], easing: 'linear' },
            ],
          },
        ],
      },
      restWire(LIMITED),
    );
    expect(foreAt(wire, 0)).toBeCloseTo(0, 9);
    expect(foreAt(wire, 0.5)).toBeCloseTo(30, 9);
    expect(foreAt(wire, 1)).toBeCloseTo(30, 9);
    expect(foreAt(wire, 0.25)).toBeCloseTo(20, 6);
  });

  it('the wire lists times that read the corner where a curve meets its limit', () => {
    // A base layer keyed 0° → 80° over a second: held at 30° from 0.375 s on.
    const keyed = (bones: BoneSpec[]) =>
      layer(
        {
          members: [{ bone: 'fore', rotationMode: 'XYZ' }],
          channels: [
            {
              bone: 'fore',
              component: 'rotation',
              keyframes: [
                { time: 0, value: [REST_X, 0, 0], easing: 'linear' },
                { time: 1, value: [REST_X + 80, 0, 0], easing: 'linear' },
              ],
            },
          ],
        },
        restWire(bones),
      );
    /** The worst error, in degrees, of reading the wire only at its listed times and slerping. */
    const worst = (wire: PosedSkeletonValue) => {
      const times = wire.clip!.times;
      let off = 0;
      for (let t = 0; t <= 1; t += 1 / 240) {
        const k = Math.max(
          1,
          times.findIndex((x) => x >= t),
        );
        const [a, b] = [times[k - 1], times[k]];
        const qa = new Quaternion(...wire.sample(a)[1].quaternion);
        const qb = new Quaternion(...wire.sample(b)[1].quaternion);
        const read = qa.slerp(qb, (t - a) / (b - a));
        off = Math.max(off, read.angleTo(new Quaternion(...wire.sample(t)[1].quaternion)) / DEG);
      }
      return off;
    };
    const free = keyed(rig());
    expect(free.clip!.times.length, 'a free linear curve needs only its keys').toBeLessThan(6);
    expect(worst(free)).toBeLessThan(1e-4);
    const heldWire = keyed(LIMITED);
    expect(heldWire.clip!.name).toBe('hand');
    expect(worst(heldWire)).toBeLessThan(2);
  });

  it('a layer above the base, and an ik layer, also hand on every frame when a limit can bite', () => {
    const moving = (bones: BoneSpec[]): PosedSkeletonValue => ({
      ...restWire(bones),
      // Not a rest pose: a motion with a range, so the layers above are not the base.
      rest: false,
      clip: { start: 0, end: 1, times: [0, 1] },
    });
    const above = { members: [{ bone: 'upper', rotationMode: 'XYZ', rotation: [40, 0, 0] }] };
    const silentIk = {
      mode: 'ik',
      weight: 0,
      ik: { root: 'upper', mid: 'fore', tip: 'tip', goal: 'goal' },
    };
    for (const params of [above, silentIk]) {
      expect(layer(params, moving(rig())).clip!.times, 'free: two samples do').toEqual([0, 1]);
      expect(layer(params, moving(LIMITED)).clip!.times.length).toBeGreaterThan(10);
    }
  });

  it('a limited bone the layer has no member for is held too', () => {
    const below = restWire(LIMITED);
    const past: PosedSkeletonValue = {
      ...below,
      sample: (t) => {
        const pose = below.sample(t).slice();
        pose[1] = { ...pose[1], quaternion: quatFromEulerXYZ([(REST_X + 80) * DEG, 0, 0]) };
        return pose;
      },
    };
    expect(fromRest(LIMITED[1], past.sample(0)[1].quaternion)[0]).toBeCloseTo(80, 9);
    const wire = layer(
      { members: [{ bone: 'upper', rotationMode: 'XYZ', rotation: [40, 0, 0] }] },
      past,
    );
    expect(foreAt(wire, 0)).toBeCloseTo(30, 9);
  });

  it('a layer at weight 0, and an ik layer, hold a limited bone they do not move', () => {
    // The wrist arrives 80° past its rest; its limit is 30°.
    const bones = rig();
    bones[2] = { ...bones[2], limits: { x: range(-10, 30) } };
    const below = restWire(bones);
    const past: PosedSkeletonValue = {
      ...below,
      sample: (t) => {
        const pose = below.sample(t).slice();
        pose[2] = { ...pose[2], quaternion: quatFromEulerXYZ([80 * DEG, 0, 0]) };
        return pose;
      },
    };
    const wristAt = (wire: PosedSkeletonValue) =>
      fromRest(bones[2], wire.sample(0)[2].quaternion)[0];
    expect(wristAt(past)).toBeCloseTo(80, 9);
    const silent = layer(
      { weight: 0, members: [{ bone: 'upper', rotationMode: 'XYZ', rotation: [40, 0, 0] }] },
      past,
    );
    expect(wristAt(silent)).toBeCloseTo(30, 9);
    const ik = { root: 'upper', mid: 'fore', tip: 'tip', goal: 'goal' };
    expect(wristAt(layer({ mode: 'ik', ik }, past))).toBeCloseTo(30, 9);
    expect(wristAt(layer({ mode: 'ik', ik, weight: 0.5 }, past))).toBeCloseTo(30, 9);
  });

  it('an ik layer’s solve is held at the limit, at full and at half weight', () => {
    const ik = { root: 'upper', mid: 'fore', tip: 'tip', goal: 'goal' };
    const full = layer({ mode: 'ik', ik }, restWire(LIMITED));
    expect(foreAt(full, 0)).toBeCloseTo(-10, 9);
    const half = layer({ mode: 'ik', ik, weight: 0.5 }, restWire(LIMITED));
    expect(foreAt(half, 0)).toBeGreaterThanOrEqual(-10 - 1e-9);
    expect(foreAt(half, 0)).toBeLessThan(0);
  });
});
