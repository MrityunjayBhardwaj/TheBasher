// #1223 — the pose wire carries name, position, quaternion and scale; clip samples slerp.
import { describe, expect, it } from 'vitest';
import { Euler, Quaternion } from 'three';
import { eulerXYZFromQuat, quatFromEulerXYZ, restBonePose } from './bonePose';
import { __clipPoseSamplerBuildsForTests, posedSkeletonFromClip } from './AnimationClip';
import { sampleQuatKeyframesExtended, type QuatKey } from './keyframeInterp';
import { slerp } from './quatMath';
import { boneWorldMatrices, posedWorldMatrices } from '../viewport/boneShape';
import type { BoneSpec, Quat, Vec3 } from './types';
import { clipValueFromKeys } from '../test-utils/clipValue';

/** Angle between two orientations, degrees — `2·atan2(|a−b|, |a+b|)`, precise near zero where
 *  `acos` of the dot product bottoms out around 1e-6°. */
function angleDeg(a: Quat, b: Quat): number {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const diff = Math.hypot(a[0] - s * b[0], a[1] - s * b[1], a[2] - s * b[2], a[3] - s * b[3]);
  const sum = Math.hypot(a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]);
  return (4 * Math.atan2(diff, sum) * 180) / Math.PI;
}

describe('bonePose — euler ↔ quaternion, the XYZ order every BoneSpec is stored in', () => {
  // A fixed spread including a gimbal case (y = ±90°), so the branch rule is exercised.
  const cases: Vec3[] = [
    [0, 0, 0],
    [0.3, -1.2, 2.5],
    [-2.9, 0.4, -0.7],
    [1.1, Math.PI / 2, 0.2],
    [0.5, -Math.PI / 2, -1.4],
    [3, 1.5, -3],
  ];

  it('quatFromEulerXYZ equals three’s Quaternion.setFromEuler', () => {
    for (const e of cases) {
      const three = new Quaternion().setFromEuler(new Euler(e[0], e[1], e[2], 'XYZ'));
      const ours = quatFromEulerXYZ(e);
      [three.x, three.y, three.z, three.w].forEach((v, k) => expect(ours[k]).toBeCloseTo(v, 12));
    }
  });

  it('eulerXYZFromQuat is the same rotation, on three’s branch', () => {
    for (const e of cases) {
      const q = quatFromEulerXYZ(e);
      const back = eulerXYZFromQuat(q);
      const three = new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]), 'XYZ');
      if (Math.abs(Math.abs(e[1]) - Math.PI / 2) > 1e-6) {
        [three.x, three.y, three.z].forEach((v, k) => expect(back[k]).toBeCloseTo(v, 9));
      }
      // At exact gimbal (y = ±90°) `asin` near 1 costs precision: 1.21e-6° here, and three's own
      // round trip loses exactly the same on the same case (measured), so the bound is the
      // algorithm's, not this port's.
      expect(angleDeg(quatFromEulerXYZ(back), q)).toBeLessThan(1e-5);
    }
  });

  it('a bone at rest carries its name, its bind orientation and its scale (1 when unstated)', () => {
    const bone: BoneSpec = {
      name: 'Bone.001',
      parent: -1,
      position: [1, 2, 3],
      rotation: [0.2, 0, 0],
    };
    expect(restBonePose(bone)).toEqual({
      name: 'Bone.001',
      position: [1, 2, 3],
      quaternion: quatFromEulerXYZ([0.2, 0, 0]),
      scale: [1, 1, 1],
    });
    expect(restBonePose({ ...bone, scale: [2, 1, 0.5] }).scale).toEqual([2, 1, 0.5]);
  });
});

describe('#1202 — a clip slerps between keys', () => {
  const skeleton = {
    kind: 'Skeleton' as const,
    bones: [{ name: 'Bone', parent: -1, position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 }],
  };
  const clipOf = (a: Vec3, b: Vec3) =>
    clipValueFromKeys({
      kind: 'AnimationClip',
      name: 'c',
      duration: 1,
      loop: 'hold',
      keyframes: [
        { bone: 0, time: 0, position: [0, 0, 0], rotation: a },
        { bone: 0, time: 1, position: [0, 0, 0], rotation: b },
      ],
      skeleton,
    });

  it('a 120° turn about (1, 1, 0) is on the slerp at the midpoint (lerping the angles missed by 24.79°)', () => {
    const axis = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const half = (120 * Math.PI) / 360;
    const end: Quat = [axis[0] * Math.sin(half), axis[1] * Math.sin(half), 0, Math.cos(half)];
    const clip = clipOf([0, 0, 0], eulerXYZFromQuat(end));
    const at = posedSkeletonFromClip(clip);
    for (const u of [0.2, 0.5, 0.8]) {
      expect(angleDeg(at.sample(u)[0].quaternion, slerp([0, 0, 0, 1], end, u))).toBeLessThan(1e-6);
    }
  });

  it('a two-axis turn between sparse keys matches slerp at t = 0.2 (60° about X → 120° about Y)', () => {
    const a = quatFromEulerXYZ([Math.PI / 3, 0, 0]);
    const b = quatFromEulerXYZ([0, (2 * Math.PI) / 3, 0]);
    const at = posedSkeletonFromClip(clipOf([Math.PI / 3, 0, 0], [0, (2 * Math.PI) / 3, 0]));
    expect(angleDeg(at.sample(0.2)[0].quaternion, slerp(a, b, 0.2))).toBeLessThan(1e-6);
    // …and the clip's own keys are exact.
    expect(angleDeg(at.sample(0)[0].quaternion, a)).toBeLessThan(1e-6);
    expect(angleDeg(at.sample(1)[0].quaternion, b)).toBeLessThan(1e-6);
  });

  it('the pose names each bone and carries its rest scale', () => {
    const scaled = { ...skeleton, bones: [{ ...skeleton.bones[0], scale: [2, 2, 2] as Vec3 }] };
    const pose = posedSkeletonFromClip({ ...clipOf([0, 0, 0], [0, 0, 1]), skeleton: scaled });
    expect(pose.sample(0.5)[0].name).toBe('Bone');
    expect(pose.sample(0.5)[0].scale).toEqual([2, 2, 2]);
  });

  it('one clip value has one pose: its samplers are built once, not per reader or per frame', () => {
    const clip = clipOf([0, 0, 0], [0, 0, 1]);
    expect(posedSkeletonFromClip(clip)).toBe(posedSkeletonFromClip(clip));
    // A copy of the clip is another value, so another pose (an overlay no longer makes one: #1236).
    expect(posedSkeletonFromClip({ ...clip })).not.toBe(posedSkeletonFromClip(clip));
  });

  it('#1237 — a pose builds its samplers on the first sample, once, and never when unread', () => {
    const clip = clipOf([0, 0, 0], [0, 0, 1]);
    const before = __clipPoseSamplerBuildsForTests();
    const pose = posedSkeletonFromClip(clip);
    expect(__clipPoseSamplerBuildsForTests(), 'made, not sampled: nothing built').toBe(before);
    const first = pose.sample(0.5);
    expect(__clipPoseSamplerBuildsForTests()).toBe(before + 1);
    pose.sample(0.25);
    posedSkeletonFromClip(clip).sample(0.75);
    expect(__clipPoseSamplerBuildsForTests(), 'every later sample reuses them').toBe(before + 1);
    // The same answer samplers built afresh give: a copy is another value, so it builds its own.
    const fresh = posedSkeletonFromClip({ ...clip }).sample(0.5);
    expect(__clipPoseSamplerBuildsForTests(), 'the copy built its own').toBe(before + 2);
    expect(first[0].quaternion).toEqual(fresh[0].quaternion);
  });
});

describe('sampleQuatKeyframesExtended — the time half of each extend rule', () => {
  const a = quatFromEulerXYZ([0, 0, 0]);
  const b = quatFromEulerXYZ([0, 0, 1]);
  const keys: QuatKey[] = [
    { time: 0, value: a, easing: 'linear' },
    { time: 1, value: b, easing: 'linear' },
  ];

  it('hold keeps the end keys; cycle folds time back into the range', () => {
    expect(sampleQuatKeyframesExtended(keys, 5, 'hold', 'hold')).toEqual(b);
    expect(sampleQuatKeyframesExtended(keys, -5, 'hold', 'hold')).toEqual(a);
    const inRange = sampleQuatKeyframesExtended(keys, 0.25);
    expect(
      angleDeg(sampleQuatKeyframesExtended(keys, 2.25, 'cycle', 'cycle'), inRange),
    ).toBeLessThan(1e-9);
  });

  it('cycle-offset adds no travel to a rotation, and slope holds', () => {
    const inRange = sampleQuatKeyframesExtended(keys, 0.25);
    expect(
      angleDeg(sampleQuatKeyframesExtended(keys, 3.25, 'cycle-offset', 'cycle-offset'), inRange),
    ).toBeLessThan(1e-9);
    expect(sampleQuatKeyframesExtended(keys, 4, 'slope', 'slope')).toEqual(b);
  });
});

describe('posedWorldMatrices — the one parent-chain walk, fed by a pose', () => {
  it('a rig posed at rest composes exactly as its bind bones do, scale and rotation included', () => {
    const bones: BoneSpec[] = [
      { name: 'Root', parent: -1, position: [0, 1, 0], rotation: [0.3, 0, 0], scale: [1, 2, 1] },
      {
        name: 'Arm',
        parent: 0,
        position: [0, 1, 0],
        rotation: [0, 0.7, -0.2],
        scale: [0.5, 0.5, 0.5],
      },
      { name: 'Hand', parent: 1, position: [1, 0, 0], rotation: [0, 0, 1.1] },
    ];
    const rest = boneWorldMatrices(bones);
    const posed = posedWorldMatrices(bones, bones.map(restBonePose));
    rest.forEach((m, i) =>
      m.elements.forEach((v, k) => expect(posed[i].elements[k]).toBeCloseTo(v, 12)),
    );
  });
});
