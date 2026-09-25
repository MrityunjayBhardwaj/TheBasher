// #1240 — a pose layer member's euler orders, named as Blender names them, against Blender itself.
//
// Oracle: Blender 5.1.1, `mathutils.Euler((0.3, -0.7, 1.1), order).to_quaternion()` for each order
// (`q1240_euler_orders.py`, run 2026-09-25), wxyz reordered to xyzw. Blender's order names the axes
// in the order they are applied, so its `XYZ` is three's `ZYX`; the codebase's own euler (three's
// `XYZ`) is Blender's `ZYX`.
import { describe, expect, it } from 'vitest';
import { EULER_ORDERS, quatFromEuler, quatFromEulerXYZ } from './bonePose';
import type { Quat, Vec3 } from './types';

const E: Vec3 = [0.3, -0.7, 1.1];
const BLENDER: Record<(typeof EULER_ORDERS)[number], Quat> = {
  XYZ: [0.29689154028892517, -0.21567240357398987, 0.5291697978973389, 0.765062153339386],
  XZY: [-0.057539984583854675, -0.21567240357398987, 0.5291697978973389, 0.818629264831543],
  YXZ: [0.29689154028892517, -0.21567240357398987, 0.44179967045783997, 0.818629264831543],
  YZX: [0.29689154028892517, -0.36242008209228516, 0.44179967045783997, 0.765062153339386],
  ZXY: [-0.057539984583854675, -0.36242008209228516, 0.5291697978973389, 0.765062153339386],
  ZYX: [-0.057539984583854675, -0.36242008209228516, 0.44179967045783997, 0.818629264831543],
};

describe('#1240 — euler orders as Blender names them', () => {
  it.each(EULER_ORDERS)('%s equals Blender 5.1.1', (order) => {
    const q = quatFromEuler(E, order);
    // Blender computes in float32; the six arms agree to its precision.
    q.forEach((c, k) => expect(c, `${order} component ${k}`).toBeCloseTo(BLENDER[order][k], 6));
  });

  it('the six orders are six different rotations on a general triple', () => {
    const keys = new Set(
      EULER_ORDERS.map((o) =>
        quatFromEuler(E, o)
          .map((c) => c.toFixed(6))
          .join(),
      ),
    );
    expect(keys.size).toBe(6);
  });

  it('Blender ZYX is the codebase’s own euler (three XYZ)', () => {
    expect(quatFromEuler(E, 'ZYX')).toEqual(quatFromEulerXYZ(E));
  });
});
