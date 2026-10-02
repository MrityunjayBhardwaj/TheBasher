// Rotation continuity through the saved-keys road (#867).
//
// `threeClipToKeys` writes rotations as an Euler triple, as clips stored them
// before format 20, and a sampler that interpolated those components LINEARLY
// (as clips did then) needs consecutive keys on nearby branches. Since #1432 only
// the v9 → v10 migration reads keys this way (`savedClipKeys.ts`), and it compares
// against channels written through exactly this conversion. That
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
import type { ClipShape } from './threeAdapter';
import { continuousEuler, threeClipToKeys } from './savedClipKeys';
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

describe('threeClipToKeys — rotation continuity (#867)', () => {
  it('emits no step whose Euler jump exceeds the rotation that actually happens', () => {
    const keys = threeClipToKeys(ySweepClip(60, 120, 30), BONES);
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
    const keys = threeClipToKeys(clip, BONES);
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
    // Proven over many rotations rather than asserted, because the whole fix
    // rests on this identity holding for THREE's XYZ convention.
    //
    // #1270 — measured against the rotation the triple HOLDS, not the quaternion it was read from.
    // Within 0.0256° of ±90° pitch, three's read snaps to its gimbal branch and sets z to 0
    // (`Euler.js:120`, `|m13| < 0.9999999`), losing up to ~0.05°. That is the reader, not the
    // identity, and comparing against `q` made an unseeded draw into that band red at random.
    // Seeded, so a failure reproduces; the band is drawn on purpose below rather than by luck.
    let seed = 1270;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const draws: Quaternion[] = [];
    for (let i = 0; i < 500; i++) {
      draws.push(
        new Quaternion(
          random() * 2 - 1,
          random() * 2 - 1,
          random() * 2 - 1,
          random() * 2 - 1,
        ).normalize(),
      );
    }
    for (const offDeg of [0, 1e-4, 1e-2, 0.02]) {
      for (const sign of [1, -1]) {
        draws.push(
          quatOf([
            (random() * 2 - 1) * Math.PI,
            (sign * (90 - offDeg)) / DEG,
            (random() * 2 - 1) * Math.PI,
          ]),
        );
      }
    }
    let worst = 0;
    for (const q of draws) {
      const e = new Euler().setFromQuaternion(q, 'XYZ');
      const held = quatOf([e.x, e.y, e.z]);
      const flipped = quatOf([e.x + Math.PI, Math.PI - e.y, e.z + Math.PI]);
      worst = Math.max(worst, 2 * Math.acos(Math.min(1, Math.abs(held.dot(flipped)))) * DEG);
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
