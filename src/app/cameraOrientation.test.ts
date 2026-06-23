// cameraOrientation — forward/inverse roundtrip + roll banking (#229).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  cameraOrientationQuat,
  composeCameraPoseWithParent,
  lookAtRollFromQuat,
} from './cameraOrientation';

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

// #231 Inc 3.3 — composing a camera's local pose with a parent Group's world.
describe('composeCameraPoseWithParent', () => {
  const basePose = {
    position: [0, 0, 0] as [number, number, number],
    lookAt: [0, 0, -1] as [number, number, number],
    roll: 0,
    fov: 45,
  };

  it('identity parent → pose unchanged (byte-identical framing)', () => {
    const out = composeCameraPoseWithParent(basePose, new THREE.Matrix4());
    expect(out.position[0]).toBeCloseTo(0);
    expect(out.position[1]).toBeCloseTo(0);
    expect(out.position[2]).toBeCloseTo(0);
    expect(out.lookAt[2]).toBeCloseTo(-1);
    expect(out.roll).toBeCloseTo(0);
    expect(out.fov).toBe(45); // spread carries the extra fields
  });

  it('a translating parent shifts BOTH position and lookAt (aim direction preserved)', () => {
    const parent = new THREE.Matrix4().makeTranslation(5, 1, 0);
    const out = composeCameraPoseWithParent(basePose, parent);
    expect(out.position[0]).toBeCloseTo(5);
    expect(out.position[1]).toBeCloseTo(1);
    expect(out.position[2]).toBeCloseTo(0);
    // lookAt translated too → still looking down -Z one unit ahead.
    expect(out.lookAt[0]).toBeCloseTo(5);
    expect(out.lookAt[1]).toBeCloseTo(1);
    expect(out.lookAt[2]).toBeCloseTo(-1);
  });

  it('a parent rotated 90° about +Y re-aims the camera (−Z → −X) at the same distance', () => {
    const parent = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    const out = composeCameraPoseWithParent(basePose, parent);
    // Position stays at origin (rotation about origin).
    expect(out.position[0]).toBeCloseTo(0);
    expect(out.position[2]).toBeCloseTo(0);
    // Local forward -Z rotated +90° about Y → -X. lookAt one unit along -X.
    expect(out.lookAt[0]).toBeCloseTo(-1);
    expect(out.lookAt[2]).toBeCloseTo(0);
  });
});
