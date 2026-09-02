// Rotation continuity through the clip adapter (#867).
//
// `clipToKeyframes` stores rotations as an Euler triple, and the playback
// sampler (`AnimationClip.ts`) interpolates those components LINEARLY. That
// contract only holds if consecutive keyframes carry NEARBY representations of
// the rotation. `Euler.setFromQuaternion` returns a CANONICAL triple, computed
// per frame with no memory, so a smooth quaternion path can land on either side
// of a branch boundary and the sampler then walks the long way round -- observed
// as a bone sweeping 360° between two keyframes a couple of degrees apart.
//
// The middle axis is the one with a restricted range in XYZ order, so a rotation
// sweeping the Y axis through ±90° is the exact case: the true motion is a few
// degrees per step while the canonical X and Z flip by π.
import { describe, it, expect } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { clipToKeyframes, continuousEuler, type ClipShape } from './threeAdapter';
import type { BoneSpec, Vec3 } from '../../nodes/types';

const DEG = 180 / Math.PI;
const BONES: BoneSpec[] = [{ name: 'b', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] }];

/** A smooth sweep about Y, straight through the branch boundary at 90°. */
function ySweepClip(fromDeg: number, toDeg: number, steps: number): ClipShape {
  const times: number[] = [];
  const values: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (fromDeg + ((toDeg - fromDeg) * i) / steps) / DEG;
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), a);
    times.push(i / 30);
    values.push(q.x, q.y, q.z, q.w);
  }
  return { tracks: [{ name: '.b.quaternion', times, values }] };
}

const quatOf = (r: readonly number[]) =>
  new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ'));

describe('clipToKeyframes — rotation continuity (#867)', () => {
  it('emits no step whose Euler jump exceeds the rotation that actually happens', () => {
    const keys = clipToKeyframes(ySweepClip(60, 120, 30), BONES);
    expect(keys.length).toBeGreaterThan(10);

    let worstExcess = 0;
    let worstAt = -1;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1].rotation;
      const b = keys[i].rotation;
      const geo = 2 * Math.acos(Math.min(1, Math.abs(quatOf(a).dot(quatOf(b))))) * DEG;
      const eul = Math.max(...[0, 1, 2].map((c) => Math.abs(b[c] - a[c]) * DEG));
      if (eul - geo > worstExcess) {
        worstExcess = eul - geo;
        worstAt = i;
      }
    }
    // A linear walk of the components must not overshoot the real rotation.
    expect(
      worstExcess,
      `worst Euler overshoot ${worstExcess.toFixed(1)}° at key ${worstAt}`,
    ).toBeLessThan(1);
  });

  it('changes only the REPRESENTATION — every keyframe still holds its original rotation', () => {
    const clip = ySweepClip(60, 120, 30);
    const keys = clipToKeyframes(clip, BONES);
    const raw = clip.tracks[0].values;
    let worst = 0;
    for (let i = 0; i < keys.length; i++) {
      const original = new Quaternion(raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3]);
      const got = quatOf(keys[i].rotation);
      worst = Math.max(worst, 2 * Math.acos(Math.min(1, Math.abs(original.dot(got)))) * DEG);
    }
    expect(worst, `worst pose drift ${worst}°`).toBeLessThan(1e-4);
  });

  it('the flip identity it relies on is real: (x+π, π−y, z+π) is the same XYZ rotation', () => {
    // Proven over random rotations rather than asserted, because the whole fix
    // rests on this identity holding for THREE's XYZ convention.
    let worst = 0;
    for (let i = 0; i < 500; i++) {
      const q = new Quaternion(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
      ).normalize();
      const e = new Euler().setFromQuaternion(q, 'XYZ');
      const flipped = quatOf([e.x + Math.PI, Math.PI - e.y, e.z + Math.PI]);
      worst = Math.max(worst, 2 * Math.acos(Math.min(1, Math.abs(q.dot(flipped)))) * DEG);
    }
    expect(worst, `worst flip error ${worst}°`).toBeLessThan(1e-4);
  });

  it('continuousEuler leaves the first sample alone and never moves a rotation', () => {
    const first: Vec3 = [0.1, 0.2, 0.3];
    expect(continuousEuler(first, null)).toEqual(first);
    const prev: Vec3 = [3.0, 0.5, -3.0];
    const canonical: Vec3 = [-3.1, 0.5, 3.1];
    const out = continuousEuler(canonical, prev);
    const drift = 2 * Math.acos(Math.min(1, Math.abs(quatOf(canonical).dot(quatOf(out))))) * DEG;
    expect(drift, 'representation changed the rotation').toBeLessThan(1e-4);
    expect(Math.max(...[0, 1, 2].map((c) => Math.abs(out[c] - prev[c])))).toBeLessThan(
      Math.max(...[0, 1, 2].map((c) => Math.abs(canonical[c] - prev[c]))),
    );
  });
});
