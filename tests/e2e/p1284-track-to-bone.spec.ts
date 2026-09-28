// #1284 — a Track-To aims at a character's BONE: the camera looking through it points at the
// drawn Hips while the walk carries them away, not at the spot the walk began.
//
// Both sides of the boundary are the drawn ones: the look-through camera the viewport renders
// with (`__basher_view_camera`) and the Hips bone the armature band draws (`__basher_armature`) —
// the example's character opens native (#1216 converts its saved clone-road rig on load). The control
// clears `aimBone` in the same page, which must turn the camera back to the character's origin —
// so a pass cannot come from a camera that happened to face the Hips anyway.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

type Vec3 = [number, number, number];

/** Degrees between the look-through camera's forward axis and the drawn Hips, at each time. */
function degreesOffHips(page: Page, times: readonly number[]) {
  return page.evaluate(async (ts) => {
    type W = {
      __basher_time: { getState: () => { setTime: (s: number) => void } };
      __basher_view_camera: () => { position: Vec3; direction: Vec3; lookThrough: boolean };
      __basher_armature?: { names: string[]; matrices: number[][] };
    };
    const w = window as unknown as W;
    const hipsIndex = w.__basher_armature?.names.findIndex((n) => /Hips$/.test(n)) ?? -1;
    if (hipsIndex < 0) return null;
    const out: { t: number; deg: number; lookThrough: boolean }[] = [];
    for (const t of ts) {
      w.__basher_time.getState().setTime(t);
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      const v = w.__basher_view_camera();
      const m = w.__basher_armature!.matrices[hipsIndex];
      const h = { x: m[12], y: m[13], z: m[14] };
      const d = [h.x - v.position[0], h.y - v.position[1], h.z - v.position[2]];
      const n = Math.hypot(d[0], d[1], d[2]);
      const cos = (d[0] * v.direction[0] + d[1] * v.direction[1] + d[2] * v.direction[2]) / n;
      out.push({
        t,
        deg: (Math.acos(Math.min(1, cos)) * 180) / Math.PI,
        lookThrough: v.lookThrough,
      });
    }
    return out;
  }, times);
}

test('the camera looks through its Track-To at the walking Hips, not where the walk began', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/:8600\//, (route) => route.abort());
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await page.getByTestId('home-open-example_camera_path_ai_walk').click();
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __basher_armature?: { bones: number };
        __basher_view_camera?: () => unknown;
      };
      return (w.__basher_armature?.bones ?? 0) > 10 && w.__basher_view_camera?.() != null;
    },
    null,
    { timeout: 30_000 },
  );
  // Look through the active camera (Numpad 0), the way a person checks a shot.
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('0');

  const times = [0, 2, 4, 6, 7.5];
  const aimed = await degreesOffHips(page, times);
  console.log(
    `[1284] aimBone=Hips: ${JSON.stringify(aimed?.map((r) => [r.t, +r.deg.toFixed(2)]))}`,
  );
  expect(aimed, 'the drawn armature has Hips').not.toBeNull();
  for (const r of aimed!) {
    expect(r.lookThrough, 'looking through the camera').toBe(true);
    expect(r.deg, `at ${r.t}s the camera faces the Hips`).toBeLessThan(0.5);
  }

  // CONTROL: clear the bone — the camera must turn back to the character's origin, off the Hips.
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_dag: {
        getState: () => {
          state: { nodes: Record<string, { type: string }> };
          dispatch: (op: unknown, src: string, d: string) => unknown;
        };
      };
    };
    const dag = w.__basher_dag.getState();
    const tt = Object.entries(dag.state.nodes).find(([, n]) => n.type === 'TrackTo')![0];
    dag.dispatch({ type: 'setParam', nodeId: tt, paramPath: 'aimBone', value: '' }, 'user', 'e2e');
  });
  const unaimed = await degreesOffHips(page, [4]);
  console.log(
    `[1284] aimBone cleared: ${JSON.stringify(unaimed?.map((r) => [r.t, +r.deg.toFixed(2)]))}`,
  );
  expect(
    unaimed![0].deg,
    'without the bone, the camera faces the origin, not the Hips',
  ).toBeGreaterThan(2);

  expect(errors).toEqual([]);
});
