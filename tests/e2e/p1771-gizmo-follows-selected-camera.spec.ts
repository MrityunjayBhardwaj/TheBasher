// #1771 — the camera gizmo sits on the camera you SELECTED, not the one that plays. Before: it was
// seeded from the active camera's pose while every drag wrote to the selected camera, so with a
// second camera selected the gizmo showed the default camera, a translate wrote the default
// camera's position plus the drag, and a re-aim kept the default camera's roll.
//
// Observed on both sides: where the gizmo is drawn, and what lands in the selected camera's params.

import { expect, test } from './_fixtures';
import { splitCameraOps } from './_splitCamera';
import { cameraRotationLookingAt } from '../../src/app/cameraOrientation';

type V3 = [number, number, number];
interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params: Record<string, unknown> }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_camera_gizmo?: () => { position: number[] | null; aim: number[] | null };
  __basher_camera_gizmo_grab?: (k: 'rotate' | 'translate' | 'aim', t: V3) => void;
}

const CAM2_POS: V3 = [20, 2, 8];
const CAM2_AIM: V3 = [20, 0, 0];
const CAM2_ROLL = 30;

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_selection);
  });
  // A second camera, NOT the active one (the scene's camera socket stays on n_camera), banked by
  // its lens roll so a roll read from the wrong camera shows.
  await page.evaluate(
    (ops) => {
      for (const op of ops) (window as unknown as W).__basher_dag.getState().dispatch(op);
    },
    splitCameraOps({
      objectId: 'cam2',
      position: CAM2_POS,
      lookAt: CAM2_AIM,
      lens: { roll: CAM2_ROLL },
    }),
  );
}

async function select(page: import('@playwright/test').Page, id: string) {
  await page.evaluate((i) => (window as unknown as W).__basher_selection.getState().select(i), id);
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_camera_gizmo_grab));
  await frames(page);
}

const frames = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );

const gizmo = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as W).__basher_camera_gizmo!());

const params = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((i) => (window as unknown as W).__basher_dag.getState().state.nodes[i].params, id);

const close = (got: number[] | null | unknown, want: number[], label: string, digits = 4) => {
  const g = got as number[];
  want.forEach((v, i) => expect(g[i], `${label}[${i}]`).toBeCloseTo(v, digits));
};

test('the gizmo sits on the selected camera, not the active one', async ({ page }) => {
  await boot(page);
  await select(page, 'cam2');
  const g = await gizmo(page);
  close(g.position, CAM2_POS, 'body');
  close(g.aim, CAM2_AIM, 'aim');

  // Control: the active camera still gets its own gizmo.
  await select(page, 'n_camera');
  const own = (await params(page, 'n_camera')).position as V3;
  close((await gizmo(page)).position, own, 'n_camera body');
});

test('a translate drag on the selected camera moves it from where it is', async ({ page }) => {
  await boot(page);
  await select(page, 'cam2');
  // A drag moves the gizmo FROM where it was drawn: one unit along +X from the drawn body.
  const from = (await gizmo(page)).position as V3;
  await page.evaluate((t) => (window as unknown as W).__basher_camera_gizmo_grab!('translate', t), [
    from[0] + 1,
    from[1],
    from[2],
  ] as V3);
  await frames(page);
  close((await params(page, 'cam2')).position, [21, 2, 8], 'cam2.position');
});

test('re-aiming the selected camera keeps its own roll', async ({ page }) => {
  await boot(page);
  await select(page, 'cam2');
  const to: V3 = [24, 0, 0];
  await page.evaluate((t) => (window as unknown as W).__basher_camera_gizmo_grab!('aim', t), to);
  await frames(page);
  // The camera turned to look at the new point, still banked by ITS roll (30°), not the active
  // camera's (0°).
  close(
    (await params(page, 'cam2')).rotation,
    cameraRotationLookingAt(CAM2_POS, to, CAM2_ROLL),
    'cam2.rotation',
    3,
  );
});
