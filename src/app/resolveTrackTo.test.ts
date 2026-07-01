// resolveTrackTo — the pure aim resolver (epic #201, slice #204). Asserts the
// derived Euler (degrees, -Z toward target, +Y up) by composing the result back
// through THREE and checking the object's -Z axis points at the target. Math-only;
// the scene-layer wiring is covered by nodeConstraints.test.ts + the e2e.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { resolveTrackTo } from './resolveTrackTo';

type Vec3 = [number, number, number];

/** The world-space -Z direction of an object with this Euler (degrees, XYZ). */
function minusZ(euler: Vec3): THREE.Vector3 {
  const e = new THREE.Euler(
    THREE.MathUtils.degToRad(euler[0]),
    THREE.MathUtils.degToRad(euler[1]),
    THREE.MathUtils.degToRad(euler[2]),
    'XYZ',
  );
  return new THREE.Vector3(0, 0, -1).applyEuler(e);
}

describe('resolveTrackTo', () => {
  it('aims -Z from the object toward the target (axis-aligned)', () => {
    // Object at origin, target at +X → -Z should point toward +X.
    const rot = resolveTrackTo([0, 0, 0], [5, 0, 0]);
    expect(rot).not.toBeNull();
    const dir = minusZ(rot!);
    expect(dir.x).toBeCloseTo(1, 5);
    expect(dir.y).toBeCloseTo(0, 5);
    expect(dir.z).toBeCloseTo(0, 5);
  });

  it('aims -Z toward an arbitrary target from an offset position', () => {
    const obj: Vec3 = [1, 2, 3];
    const target: Vec3 = [4, 2, -1];
    const rot = resolveTrackTo(obj, target);
    expect(rot).not.toBeNull();
    const dir = minusZ(rot!);
    const want = new THREE.Vector3(
      target[0] - obj[0],
      target[1] - obj[1],
      target[2] - obj[2],
    ).normalize();
    expect(dir.x).toBeCloseTo(want.x, 5);
    expect(dir.y).toBeCloseTo(want.y, 5);
    expect(dir.z).toBeCloseTo(want.z, 5);
  });

  it('matches the camera convention: -Z toward target == THREE Matrix4.lookAt', () => {
    // Track-To must be byte-compatible with the camera lookAt it will absorb.
    const obj: Vec3 = [3, 2, 3];
    const target: Vec3 = [0, 0, 0];
    const rot = resolveTrackTo(obj, target)!;
    const m = new THREE.Matrix4().lookAt(
      new THREE.Vector3(...obj),
      new THREE.Vector3(...target),
      new THREE.Vector3(0, 1, 0),
    );
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    expect(rot[0]).toBeCloseTo(THREE.MathUtils.radToDeg(e.x), 5);
    expect(rot[1]).toBeCloseTo(THREE.MathUtils.radToDeg(e.y), 5);
    expect(rot[2]).toBeCloseTo(THREE.MathUtils.radToDeg(e.z), 5);
  });

  it('returns null when object and target coincide (aim undefined)', () => {
    expect(resolveTrackTo([2, 2, 2], [2, 2, 2])).toBeNull();
  });

  it('a moving target yields distinct aims (the constraint follows)', () => {
    const a = resolveTrackTo([0, 0, 0], [1, 0, 0])!;
    const b = resolveTrackTo([0, 0, 0], [0, 0, 1])!;
    // Aiming at +X vs +Z → different rotations.
    expect(a).not.toEqual(b);
    expect(minusZ(a).x).toBeCloseTo(1, 5);
    expect(minusZ(b).z).toBeCloseTo(1, 5);
  });
});
