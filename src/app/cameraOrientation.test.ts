// cameraOrientation — forward/inverse roundtrip + roll banking (#229).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cameraOrientationQuat, lookAtRollFromQuat } from './cameraOrientation';

const FWD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

describe('cameraOrientationQuat', () => {
  it('is identity when looking down -Z with no roll', () => {
    const q = cameraOrientationQuat([0, 0, 0], [0, 0, -1], 0);
    const fwd = FWD.clone().applyQuaternion(q);
    expect(fwd.x).toBeCloseTo(0);
    expect(fwd.y).toBeCloseTo(0);
    expect(fwd.z).toBeCloseTo(-1);
    // up stays world +Y at roll 0
    const up = UP.clone().applyQuaternion(q);
    expect(up.y).toBeCloseTo(1);
  });

  it('points local -Z at the lookAt target (any roll)', () => {
    for (const roll of [0, 30, -90, 180]) {
      const q = cameraOrientationQuat([3, 2, 3], [0, 0, 0], roll);
      const fwd = FWD.clone().applyQuaternion(q).normalize();
      const expected = new THREE.Vector3(-3, -2, -3).normalize();
      expect(fwd.x).toBeCloseTo(expected.x);
      expect(fwd.y).toBeCloseTo(expected.y);
      expect(fwd.z).toBeCloseTo(expected.z);
    }
  });

  it('roll banks the up-vector about the view axis (forward unchanged)', () => {
    // Looking down -Z, a +90° roll about the view axis (-Z) rotates up (+Y) to +X.
    const q = cameraOrientationQuat([0, 0, 0], [0, 0, -1], 90);
    const fwd = FWD.clone().applyQuaternion(q);
    const up = UP.clone().applyQuaternion(q);
    expect(fwd.z).toBeCloseTo(-1); // aim unchanged
    expect(up.x).toBeCloseTo(1); // up rolled 90° about -Z
    expect(up.y).toBeCloseTo(0);
  });
});

describe('lookAtRollFromQuat (inverse — gizmo write-back)', () => {
  it('round-trips (position, lookAt, roll) through the world quaternion', () => {
    const cases: { pos: [number, number, number]; look: [number, number, number]; roll: number }[] =
      [
        { pos: [3, 2, 3], look: [0, 0, 0], roll: 0 },
        { pos: [0, 0, 5], look: [0, 0, 0], roll: 35 },
        { pos: [1, 4, -2], look: [2, 1, 1], roll: -60 },
      ];
    for (const c of cases) {
      const dist = Math.hypot(c.look[0] - c.pos[0], c.look[1] - c.pos[1], c.look[2] - c.pos[2]);
      const q = cameraOrientationQuat(c.pos, c.look, c.roll);
      const out = lookAtRollFromQuat(q, c.pos, dist);
      expect(out.lookAt[0]).toBeCloseTo(c.look[0]);
      expect(out.lookAt[1]).toBeCloseTo(c.look[1]);
      expect(out.lookAt[2]).toBeCloseTo(c.look[2]);
      expect(out.roll).toBeCloseTo(c.roll);
    }
  });
});
