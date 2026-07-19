// #204 (epic #201) — the H40 boundary-pair for the Track-To constraint: the REAL
// rendered object's world orientation (side A) == the pure resolver (side B), with
// the physical check that the rendered -Z axis points from the constrained box
// toward a MOVING target, at ≥2 playhead times.
//
// The hard risk: the render's derived rotation (ConstrainedR) DRIFTS from the
// read-side / pure aim (resolveTrackTo). Falsify: mute the constraint or break the
// aim math → the rendered -Z no longer points at the target and side A ≠ side B.
//
// Side A: __basher_mesh_world_quaternion(boxId) → applied to (0,0,-1) = rendered
//   aim direction. Side B: __basher_evaluated_transform(boxId).rotation (the
//   derived Euler the read resolver returns) → same -Z direction.

import { expect, test } from './_fixtures';
import { splitCubeOps } from './_splitCube';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: number[]; rotation: number[] | null; scale: number[] | null } | null;
  __basher_mesh_world_quaternion?: (nodeId: string) => [number, number, number, number] | null;
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
}

const BOX_ID = 'n_box'; // the constrained object (default-project box, at origin)
const TARGET_ID = 'n_p204_target';

/** -Z direction of a quaternion [x,y,z,w], in world space (pure quat·(0,0,-1)). */
function minusZFromQuat(q: number[]): [number, number, number] {
  const [x, y, z, w] = q;
  // v' = q * (0,0,-1) * q⁻¹ — expanded for v=(0,0,-1).
  const vx = 0,
    vy = 0,
    vz = -1;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  // v' = v + w*t + cross(q.xyz, t)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function minusZFromEulerDeg(e: number[]): [number, number, number] {
  const d = Math.PI / 180;
  const x = e[0] * d;
  const y = e[1] * d;
  const sx = Math.sin(x);
  const cx = Math.cos(x);
  const sy = Math.sin(y);
  const cy = Math.cos(y);
  // THREE makeRotationFromEuler('XYZ') third column = (sin y, -sin x·cos y,
  // cos x·cos y); the object's -Z axis is its negation (roll z doesn't affect it).
  return [-sy, sx * cy, -cx * cy];
}

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

async function buildBoxTrackingMovingTarget(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_time);
  });
  await page.evaluate(
    ({ boxId, targetId, targetOps }) => {
      const w = window as unknown as BasherWindow;
      const dispatch = (op: unknown) => w.__basher_dag!.getState().dispatch(op);
      // Box at origin (default). Add a target box that animates +X → +Z.
      dispatch({ type: 'setParam', nodeId: boxId, paramPath: 'position', value: [0, 0, 0] });
      // #365 Slice 2: the aim target is a split cube (Object → BoxData); the Object
      // keeps targetId, so the position channel + Track-To aimNode are unchanged.
      for (const op of targetOps) dispatch(op);
      dispatch({
        type: 'connect',
        from: { node: targetId, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      });
      dispatch({
        type: 'addNode',
        nodeId: 'n_p204_target_ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'tgtpos',
          target: targetId,
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [10, 0, 0], easing: 'linear' },
            { time: 2, value: [0, 0, 10], easing: 'linear' },
          ],
        },
      });
      // Track-To: n_box aims at the (moving) target node.
      dispatch({
        type: 'addNode',
        nodeId: 'n_p204_tt',
        nodeType: 'TrackTo',
        params: {
          name: 'tt',
          target: boxId,
          aimNode: targetId,
          aimPoint: [0, 0, 0],
          up: [0, 1, 0],
          mute: false,
        },
      });
    },
    {
      boxId: BOX_ID,
      targetId: TARGET_ID,
      targetOps: splitCubeOps({ objectId: TARGET_ID, position: [10, 0, 0] }),
    },
  );
}

test.describe('#204 Track-To boundary-pair (H40)', () => {
  test('rendered -Z aims at the moving target == resolver, ≥2 times', async ({ page }) => {
    await page.goto('/');
    await buildBoxTrackingMovingTarget(page);

    // Target world X/Z at t: lerp [10,0,0]→[0,0,10] over [0,2].
    const samples = [
      { seconds: 0, targetPos: [10, 0, 0] as [number, number, number] },
      { seconds: 2, targetPos: [0, 0, 10] as [number, number, number] },
    ];

    for (const s of samples) {
      await page.evaluate((seconds) => {
        const w = window as unknown as BasherWindow;
        w.__basher_time!.getState().pause();
        w.__basher_time!.getState().setTime(seconds);
      }, s.seconds);

      // Wait for the target to render at the sampled position (ConstrainedR + the
      // target's own channel both settle via useFrame).
      await page.waitForFunction(
        ({ targetId, tx }) => {
          const w = window as unknown as BasherWindow;
          const p = w.__basher_mesh_world_position?.(targetId);
          return p != null && Math.abs(p[0] - tx) < 1e-2;
        },
        { targetId: TARGET_ID, tx: s.targetPos[0] },
      );

      const { quat, euler } = await page.evaluate(
        ({ boxId, seconds }) => {
          const w = window as unknown as BasherWindow;
          const ctx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
          return {
            quat: w.__basher_mesh_world_quaternion!(boxId), // side A (rendered)
            euler: w.__basher_evaluated_transform!(boxId, ctx)?.rotation ?? null, // side B (resolver)
          };
        },
        { boxId: BOX_ID, seconds: s.seconds },
      );

      expect(quat).not.toBeNull();
      expect(euler).not.toBeNull();
      const dirA = norm(minusZFromQuat(quat!)); // rendered aim direction
      const dirB = norm(minusZFromEulerDeg(euler!)); // resolver aim direction
      const want = norm(s.targetPos); // box at origin → aim toward target position
      console.log(
        `[p204 t=${s.seconds}] dirA=${JSON.stringify(dirA.map((n) => +n.toFixed(3)))} dirB=${JSON.stringify(dirB.map((n) => +n.toFixed(3)))} want=${JSON.stringify(want.map((n) => +n.toFixed(3)))}`,
      );

      // H40 boundary-pair: rendered aim == resolver aim, all three axes.
      expect(dirA[0]).toBeCloseTo(dirB[0], 3);
      expect(dirA[1]).toBeCloseTo(dirB[1], 3);
      expect(dirA[2]).toBeCloseTo(dirB[2], 3);
      // Physical: the rendered -Z actually points at the target.
      expect(dirA[0]).toBeCloseTo(want[0], 2);
      expect(dirA[1]).toBeCloseTo(want[1], 2);
      expect(dirA[2]).toBeCloseTo(want[2], 2);
    }
  });
});
