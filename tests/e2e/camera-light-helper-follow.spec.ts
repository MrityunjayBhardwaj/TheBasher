// #240 / #241 ([[V85]] / [[H132]]) — an editor VISUAL of an animatable object must
// FOLLOW the object's evaluated pose at the live playhead, the same way meshes /
// lights / the look-through camera do (their per-frame `DirectChannels*` overlays).
// Before the fix the camera frustum (`CameraHelper`) and light wireframe helpers
// (`LightHelper`) rendered the STATIC frame-0 channel-blind read with no follower,
// so they froze at frame 0 while the gizmo + real object moved (the render-source
// split). This drives the LIVE app (Lokayata) and reads the rendered helper's pose
// via the DEV seams (`__basher_frustum_pose` / `__basher_lighthelper_value`).
//
// FALSIFIABLE: each assertion checks the MOVED value (x≈12 / x≈-9 / x≈20), distinct
// from the frame-0 value (x≈3 / x≈5) — a frozen helper makes them RED.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
  __basher_frustum_pose?: Record<string, { position: [number, number, number] }>;
  __basher_lighthelper_value?: Record<string, { position: [number, number, number] }>;
}

async function addVec3Channel(
  page: import('@playwright/test').Page,
  id: string,
  target: string,
  paramPath: string,
  keyframes: unknown[],
) {
  await page.evaluate(
    ({ id, target, paramPath, keyframes }) => {
      (window as unknown as W).__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: id,
            nodeType: 'KeyframeChannelVec3',
            params: { name: paramPath, target, paramPath, keyframes },
          },
        ],
        'e2e',
        'add channel',
      );
    },
    { id, target, paramPath, keyframes },
  );
}

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate(
    (s) => (window as unknown as W).__basher_time!.getState().setTime(s),
    seconds,
  );
  await page.waitForTimeout(200); // let the per-frame follower apply the evaluated pose
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag?.getState()?.state?.outputs?.scene && w.__basher_time);
  });
});

test('#240 — an animated camera frustum follows the playhead (not frozen at frame 0)', async ({
  page,
}) => {
  await addVec3Channel(page, 'cam_pos_ch', 'n_camera', 'position', [
    { time: 0, value: [3, 2, 3], easing: 'linear' },
    { time: 1, value: [12, 2, 3], easing: 'linear' },
  ]);
  await setTime(page, 0);
  const at0 = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  await setTime(page, 1);
  const at1 = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  expect(at0).not.toBeNull();
  expect(at0![0]).toBeCloseTo(3, 0);
  expect(at1![0]).toBeCloseTo(12, 0); // followed the channel, not frozen at 3
});

test('#240 — editing the camera channel AT the current frame moves the frustum same-frame (the reported gizmo-drag scenario; channel-blind defect)', async ({
  page,
}) => {
  // The literal report: an animated camera, a gizmo edit at frame > 0 moves the
  // real camera but not the frustum — because the OLD frustum resolver was
  // channel-BLIND (read raw params, ignored the keyframe channel the gizmo writes).
  // Here we edit the channel keyframe at the current frame (what routeAnimatedGrab
  // does) WITHOUT scrubbing, and assert the frustum tracks it on the same frame.
  await addVec3Channel(page, 'cam_pos_ch2', 'n_camera', 'position', [
    { time: 0, value: [3, 2, 3], easing: 'linear' },
    { time: 1, value: [12, 2, 3], easing: 'linear' },
  ]);
  await setTime(page, 1);
  const before = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  expect(before![0]).toBeCloseTo(12, 0);
  // Re-key t=1 → x=20 (the channel edit a gizmo drag at this frame produces).
  await page.evaluate(() =>
    (window as unknown as W).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: 'cam_pos_ch2',
          paramPath: 'keyframes',
          value: [
            { time: 0, value: [3, 2, 3], easing: 'linear' },
            { time: 1, value: [20, 2, 3], easing: 'linear' },
          ],
        },
      ],
      'e2e',
      'rekey',
    ),
  );
  await page.waitForTimeout(200); // no scrub — the follower re-samples on state change
  const after = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  expect(after).not.toBeNull();
  expect(after![0]).toBeCloseTo(20, 0); // frustum followed the same-frame channel edit, not stuck at 12
});

test('#241 — an animated light wireframe helper follows the playhead', async ({ page }) => {
  await addVec3Channel(page, 'light_pos_ch', 'n_light', 'position', [
    { time: 0, value: [5, 5, 5], easing: 'linear' },
    { time: 1, value: [-9, 5, 5], easing: 'linear' },
  ]);
  await setTime(page, 0);
  const at0 = await page.evaluate(
    () => (window as unknown as W).__basher_lighthelper_value?.['n_light']?.position ?? null,
  );
  await setTime(page, 1);
  const at1 = await page.evaluate(
    () => (window as unknown as W).__basher_lighthelper_value?.['n_light']?.position ?? null,
  );
  expect(at0).not.toBeNull();
  expect(at0![0]).toBeCloseTo(5, 0);
  expect(at1![0]).toBeCloseTo(-9, 0); // followed the channel, not frozen at 5
});
