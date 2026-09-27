// #1282 — the "Camera Path + AI Walk" example opens from the startup screen and plays with no
// motion server.
//
// It is the first example with a stored asset (the character's GLB, a seeded catalog asset,
// because a saved scene carries no asset bytes — #1281) and a generated motion (its clip holds
// the keys Kimodo produced). So what is checked is what a person would see: the example card
// opens it, the character's bones move with the playhead, and the camera travels its path —
// with every request to the motion server refused, so a quiet pass cannot come from a server
// that happened to be running.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

type Vec3 = [number, number, number];
interface Win {
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => {
    boneCount: number;
    boneRotation: (i: number) => Vec3 | null;
  } | null;
  __basher_frustum_pose?: Record<string, { position: Vec3 }>;
}

/** At `t` seconds, once the frame after the time change has drawn: every bone's rotation and
 *  the camera's evaluated position. */
function sampleAt(page: Page, t: number) {
  return page.evaluate(async (sec) => {
    const w = window as unknown as Win;
    w.__basher_time!.getState().setTime(sec);
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    const skin = w.__basher_gltf_skin!()!;
    return {
      bones: Array.from({ length: skin.boneCount }, (_, i) => skin.boneRotation(i)),
      camera: w.__basher_frustum_pose?.['n_camera']?.position ?? null,
    };
  }, t);
}

test('the Camera Path + AI Walk example opens from the startup screen and plays offline', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let serverRequests = 0;
  await page.route(/:8600\//, (route) => {
    serverRequests++;
    return route.abort();
  });
  // A first run: no remembered project, so boot lands on the startup screen.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('home-view')).toBeVisible();
  await page.getByTestId('home-open-example_camera_path_ai_walk').click();

  await page.waitForFunction(
    () => (window as unknown as Win).__basher_gltf_skin?.() != null,
    null,
    { timeout: 30_000 },
  );
  // The walk: each bone's WIDEST swing from its frame-0 pose over several times. Two instants
  // alone can land on the same phase of a stride and read a walking character as still.
  const times = [0, 0.4, 0.8, 1.2, 1.6, 2.0, 3.0];
  const samples: Awaited<ReturnType<typeof sampleAt>>[] = [];
  for (const t of times) samples.push(await sampleAt(page, t));
  const a = samples[0];
  const b = samples[samples.length - 1];
  const swung = a.bones.filter((q, i) =>
    samples.some((s) => {
      const r = s.bones[i];
      return q && r && Math.max(...q.map((v, k) => Math.abs(v - r[k]))) > 0.2;
    }),
  ).length;
  console.log(
    `[1282] bones=${a.bones.length} swung=${swung} camera ${JSON.stringify(a.camera)} -> ${JSON.stringify(b.camera)}`,
  );
  expect(a.bones.length, 'the character is rigged').toBeGreaterThan(10);
  expect(swung, 'the character walks').toBeGreaterThanOrEqual(5);

  // The camera path: the camera's evaluated position moves along its curve.
  expect(a.camera, 'the camera is drawn').not.toBeNull();
  const travelled = Math.hypot(...a.camera!.map((v, k) => v - b.camera![k]));
  expect(travelled, 'the camera travels its path').toBeGreaterThan(0.1);

  expect(errors).toEqual([]);
  expect(serverRequests, 'no request reached for the motion server').toBe(0);
});
