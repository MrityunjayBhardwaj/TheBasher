// #1240 — a pose layer member's euler orders, named as Blender names them, against Blender itself.
//
// Oracle: Blender 5.1.1, `mathutils.Euler((0.3, -0.7, 1.1), order).to_quaternion()` for each order
// (`q1240_euler_orders.py`, run 2026-09-25), wxyz reordered to xyzw. Blender's order names the axes
// in the order they are applied, so its `XYZ` is three's `ZYX`; the codebase's own euler (three's
// `XYZ`) is Blender's `ZYX`.
import { describe, expect, it } from 'vitest';
import { Euler, Quaternion } from 'three';
import {
  EULER_ORDERS,
  continuousEulerIn,
  eulerFromQuat,
  flippedEuler,
  quatFromEuler,
  quatFromEulerXYZ,
} from './bonePose';
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

describe('#1242 — euler from a quaternion, in each order', () => {
  // Deterministic spread of rotations, avoiding the exact gimbal edge.
  const samples: Vec3[] = [];
  for (let i = 0; i < 40; i++) {
    samples.push([Math.sin(i * 1.3) * 3, Math.sin(i * 0.7 + 1) * 1.4, Math.cos(i * 2.1) * 3]);
  }
  it.each(EULER_ORDERS)(
    '%s round-trips: euler → quaternion → euler → the same rotation',
    (order) => {
      for (const e of samples) {
        const q = quatFromEuler(e, order);
        const back = quatFromEuler(eulerFromQuat(q, order), order);
        const same = Math.abs(q[0] * back[0] + q[1] * back[1] + q[2] * back[2] + q[3] * back[3]);
        expect(same, `${order} ${e.join(',')}`).toBeCloseTo(1, 9);
      }
    },
  );

  it.each(EULER_ORDERS)('%s agrees with three’s own decomposition', (order) => {
    const threeOrder = order.split('').reverse().join('') as 'XYZ';
    for (const e of samples) {
      const q = quatFromEuler(e, order);
      const t = new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]), threeOrder);
      const mine = eulerFromQuat(q, order);
      [t.x, t.y, t.z].forEach((c, k) => expect(mine[k], `${order} axis ${k}`).toBeCloseTo(c, 9));
    }
  });

  it.each(EULER_ORDERS)('%s: the flipped triple is the same rotation', (order) => {
    for (const e of samples) {
      const a = quatFromEuler(e, order);
      const b = quatFromEuler(flippedEuler(e, order), order);
      const same = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
      expect(same, `${order} ${e.join(',')}`).toBeCloseTo(1, 9);
    }
  });

  // The measurement that made `flippedEuler` order-aware: the clip reader's fixed form, (x+π, π−y,
  // z+π), is a different rotation in every order whose middle axis is not Y.
  it('the fixed (x+π, π−y, z+π) form holds only for the Y-middle orders', () => {
    const e = samples[3];
    const holds = EULER_ORDERS.filter((order) => {
      const a = quatFromEuler(e, order);
      const b = quatFromEuler([e[0] + Math.PI, Math.PI - e[1], e[2] + Math.PI], order);
      return Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) - 1) < 1e-9;
    });
    expect(holds).toEqual(['XYZ', 'ZYX']);
  });

  it.each(EULER_ORDERS)(
    '%s: a sweep through 350° → 10° about each axis stays continuous',
    (order) => {
      for (const axis of [0, 1, 2]) {
        let prev: Vec3 | null = null;
        for (let deg = 340; deg <= 380; deg += 2) {
          const e: Vec3 = [0.2, 0.3, 0.1].map((v, k) =>
            k === axis ? (deg * Math.PI) / 180 : v,
          ) as unknown as Vec3;
          const q = quatFromEuler(e, order);
          const next = continuousEulerIn(eulerFromQuat(q, order), prev, order);
          // The same rotation…
          const back = quatFromEuler(next, order);
          expect(
            Math.abs(q[0] * back[0] + q[1] * back[1] + q[2] * back[2] + q[3] * back[3]),
          ).toBeCloseTo(1, 9);
          // …and no component jumps more than the 2° step (plus slack for the other axes' coupling).
          if (prev) {
            const jump = Math.max(...next.map((c, k) => Math.abs(c - prev![k])));
            expect(jump, `${order} axis ${axis} at ${deg}°`).toBeLessThan((10 * Math.PI) / 180);
          }
          prev = next;
        }
      }
    },
  );
});
