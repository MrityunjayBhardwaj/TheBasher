// #1153 — a quaternion-mode Object, Group and light DRAW their quaternion.
//
// The unit gate (src/app/resolvedRotation.gate.test.ts) covers the read side. What only a
// browser shows is the draw: `MeshChild` (every scene child), `LightKindR` (every light
// road), and the Track-To patch in `ConstrainedR`. Each row reads the REAL
// rendered three object — its world quaternion, or a light's aim — and every node carries a
// DECOY euler `rotation`, so a road that skipped the resolution would draw the decoy.
//
// Expected orientations are composed here with three's own math from the quaternion the row
// wrote, never read back from the app.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

type Q = [number, number, number, number];
type V = [number, number, number];
interface W {
  __basher_dag?: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_mesh_world_quaternion?: (id: string) => Q | null;
  __basher_light_world_aims?: () => { position: V; direction: V }[];
}

const D2R = Math.PI / 180;
const DECOY: V = [10, 20, 30];

function axisAngle(axis: V, deg: number): Q {
  const l = Math.hypot(...axis);
  const s = Math.sin((deg * D2R) / 2);
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos((deg * D2R) / 2)];
}
const Q170 = axisAngle([1, 1, 0], 170);

// Plain quaternion math (xyzw), so the expectation owes nothing to the code under test.
const mul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function fromEulerXYZ(d: V): Q {
  const [x, y, z] = d.map((v) => v * D2R);
  const qx: Q = [Math.sin(x / 2), 0, 0, Math.cos(x / 2)];
  const qy: Q = [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
  const qz: Q = [0, 0, Math.sin(z / 2), Math.cos(z / 2)];
  return mul(mul(qx, qy), qz); // three's 'XYZ': R = Rx · Ry · Rz
}
function slerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? (b.map((v) => -v) as Q) : b;
  d = Math.abs(d);
  if (d > 0.9995) return a.map((v, i) => v + (bb[i] - v) * t) as Q;
  const th = Math.acos(d);
  const s = Math.sin(th);
  return a.map((v, i) => (Math.sin((1 - t) * th) / s) * v + (Math.sin(t * th) / s) * bb[i]) as Q;
}
function rotate(q: Q, v: V): V {
  const r = mul(mul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [r[0], r[1], r[2]];
}
const angleDeg = (a: Q, b: Q) =>
  (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])))) /
  D2R;

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_mesh_world_quaternion);
  });
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
}
async function dispatch(page: Page, ops: unknown[]) {
  await page.evaluate((ops) => {
    const d = (window as unknown as W).__basher_dag!.getState();
    for (const op of ops) d.dispatch(op);
  }, ops);
}
const setParams = (nodeId: string, params: Record<string, unknown>) =>
  Object.entries(params).map(([paramPath, value]) => ({
    type: 'setParam',
    nodeId,
    paramPath,
    value,
  }));
const drawnQuat = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).__basher_mesh_world_quaternion!(id), id);

test('#1153 — an Object in quaternion mode draws its quaternion, not its euler', async ({
  page,
}) => {
  await ready(page);
  await dispatch(page, setParams('n_box', { rotation: DECOY }));
  // Positive control: the reading sees the euler it is told to expect.
  await expect
    .poll(async () => angleDeg((await drawnQuat(page, 'n_box'))!, fromEulerXYZ(DECOY)))
    .toBeLessThan(1e-3);

  await dispatch(page, setParams('n_box', { rotationMode: 'quaternion', quaternion: Q170 }));
  await expect
    .poll(async () => angleDeg((await drawnQuat(page, 'n_box'))!, Q170))
    .toBeLessThan(1e-3);
});

test('#1153 — a quaternion channel draws the slerp at every sampled time', async ({ page }) => {
  await ready(page);
  const KEYS: Q[] = [[0, 0, 0, 1], Q170, axisAngle([0, 0, 1], 90)];
  await dispatch(page, [
    ...setParams('n_box', {
      rotation: DECOY,
      rotationMode: 'quaternion',
      quaternion: [0, 0, 0, 1],
    }),
    {
      type: 'addNode',
      nodeId: 'n_box_quaternion_channel',
      nodeType: 'KeyframeChannelQuat',
      params: {
        name: 'quaternion',
        target: 'n_box',
        paramPath: 'quaternion',
        keyframes: KEYS.map((value, i) => ({ time: i, value, easing: 'linear' })),
      },
    },
  ]);
  const checked: number[] = [];
  for (const t of [0, 0.5, 1, 1.5, 2]) {
    await page.evaluate((t) => (window as unknown as W).__basher_time!.getState().setTime(t), t);
    const i = Math.min(Math.floor(t), 1);
    const want = slerp(KEYS[i], KEYS[i + 1], t - i);
    await expect
      .poll(async () => angleDeg((await drawnQuat(page, 'n_box'))!, want))
      .toBeLessThan(1e-3);
    checked.push(t);
  }
  expect(checked).toHaveLength(5);
});

test('#1153 — a Track-To aim draws the same in quaternion mode as in euler', async ({ page }) => {
  await ready(page);
  await dispatch(page, [
    {
      type: 'addNode',
      nodeId: 'n_aim',
      nodeType: 'TrackTo',
      params: { target: 'n_box', aimPoint: [3, -2, -5] },
    },
  ]);
  // Wait for the aim to take (the drawn box turns away from identity), then record it.
  await expect
    .poll(async () => angleDeg((await drawnQuat(page, 'n_box'))!, [0, 0, 0, 1]))
    .toBeGreaterThan(1);
  const euler = (await drawnQuat(page, 'n_box'))!;

  await dispatch(
    page,
    setParams('n_box', { rotation: DECOY, rotationMode: 'quaternion', quaternion: Q170 }),
  );
  // Give the draw a chance to (wrongly) put the quaternion back over the aim before reading.
  await page.waitForTimeout(500);
  await expect
    .poll(async () => angleDeg((await drawnQuat(page, 'n_box'))!, euler))
    .toBeLessThan(1e-3);
});

test('#1153 — a Group in quaternion mode turns the child it holds', async ({ page }) => {
  await ready(page);
  await dispatch(page, [
    { type: 'addNode', nodeId: 'g1153', nodeType: 'Group', params: {} },
    { type: 'addNode', nodeId: 'kid1153', nodeType: 'Object', params: { position: [1, 0, 0] } },
    {
      type: 'connect',
      from: { node: 'n_box_data', socket: 'out' },
      to: { node: 'kid1153', socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: 'kid1153', socket: 'out' },
      to: { node: 'g1153', socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: 'g1153', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    ...setParams('g1153', { rotation: DECOY, rotationMode: 'quaternion', quaternion: Q170 }),
  ]);
  // Read through the Group: a NESTED object's drawn three object carries no node id (#1075), so
  // the seam is addressed at the top-level Group and returns the first mesh under it — the kid,
  // whose own rotation is identity, so its world orientation is the Group's.
  await expect
    .poll(async () => angleDeg((await drawnQuat(page, 'g1153'))!, Q170))
    .toBeLessThan(1e-3);
});

test('#1153 — a light Object in quaternion mode aims by its quaternion', async ({ page }) => {
  await ready(page);
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_light_world_aims));
  const aimOfSun = () =>
    page.evaluate(() =>
      (window as unknown as W).__basher_light_world_aims!().find(
        (a) => Math.abs(a.position[0] - 5) < 1e-6 && Math.abs(a.position[1] - 5) < 1e-6,
      ),
    );
  const q = axisAngle([1, 0, 0], 60);
  await dispatch(
    page,
    setParams('n_light', { rotation: DECOY, rotationMode: 'quaternion', quaternion: q }),
  );
  const want = rotate(q, [0, -1, 0]);
  await expect
    .poll(async () => {
      const a = await aimOfSun();
      if (!a) return 'no sun';
      return Math.max(...a.direction.map((v, i) => Math.abs(v - want[i])));
    })
    .toBeLessThan(1e-4);
});

test('#1153 — the diff ghost of a quaternion-mode proposal draws the quaternion', async ({
  page,
}) => {
  await ready(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_diff?: unknown }).__basher_diff),
  );
  // PROPOSED, not committed: the ghost draws its own tree (DiffOverlay's GhostChild), which
  // never passes through MeshChild.
  await page.evaluate(
    ({ decoy, q }) => {
      const w = window as unknown as {
        __basher_dag: { getState(): { state: unknown } };
        __basher_diff: { getState(): { propose: (s: unknown, ops: unknown[], d: string) => void } };
      };
      const ops = [
        { type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: decoy },
        { type: 'setParam', nodeId: 'n_box', paramPath: 'rotationMode', value: 'quaternion' },
        { type: 'setParam', nodeId: 'n_box', paramPath: 'quaternion', value: q },
      ];
      w.__basher_diff.getState().propose(w.__basher_dag.getState().state, ops, 'turn the cube');
    },
    { decoy: DECOY, q: Q170 },
  );
  await expect(page.getByTestId('diffbar')).toBeVisible();
  // The ghost's own signature (DiffOverlay's styling: wireframe at opacity 0.35) plus the
  // cube's width — p352's discriminator, never `editorChrome` (H171).
  const ghostQuats = () =>
    page.evaluate(() => {
      const scene = (
        window as unknown as {
          __basher_three: { getState(): { scene: { traverse(cb: (o: unknown) => void): void } } };
        }
      ).__basher_three.getState().scene;
      const hits: Q[] = [];
      scene.traverse((o: unknown) => {
        const obj = o as {
          material?: { opacity?: number; wireframe?: boolean };
          geometry?: { parameters?: { width?: number } };
          updateWorldMatrix?: (a: boolean, b: boolean) => void;
          getWorldQuaternion?: (q: unknown) => unknown;
          quaternion?: { clone(): { x: number; y: number; z: number; w: number } };
        };
        if (!obj.material || !obj.geometry || !obj.quaternion || !obj.getWorldQuaternion) return;
        if (obj.material.opacity !== 0.35 || obj.material.wireframe !== true) return;
        if (obj.geometry.parameters?.width !== 1) return;
        obj.updateWorldMatrix?.(true, false);
        const q = obj.quaternion.clone();
        obj.getWorldQuaternion(q);
        hits.push([q.x, q.y, q.z, q.w]);
      });
      return hits;
    });
  await expect.poll(async () => (await ghostQuats()).length).toBe(1);
  await expect.poll(async () => angleDeg((await ghostQuats())[0], Q170)).toBeLessThan(1e-3);
});
