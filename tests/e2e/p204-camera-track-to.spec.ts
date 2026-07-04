// #204 (epic #201) — the camera-lookAt migration onto Track-To, observed on the
// REAL R3F look-through view camera (Lokayata): a Track-To on the camera node
// makes it AIM at a moving target through the SAME constraint machinery meshes
// use. The boundary-pair: the look-through camera's world forward (-Z, side A)
// points from the camera toward the target's world position, at ≥2 times.
//
// Falsify: mute the camera Track-To → the camera reverts to its static lookAt
// (origin) and the forward no longer tracks the target.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_view_camera?: () => {
    position: [number, number, number];
    direction: [number, number, number];
    fov: number | null;
    lookThrough: boolean;
  } | null;
  __basher_viewport?: { getState: () => { lookThroughCamera: boolean } };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
  __basher_dag?: {
    getState: () => { dispatch: (op: unknown, source: string, desc: string) => void };
  };
}

const TARGET_ID = 'n_cam_target';

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_view_camera && w.__basher_viewport && w.__basher_time && w.__basher_dag,
    );
  });
  await page.waitForTimeout(300);
}

async function dispatch(page: import('@playwright/test').Page, op: unknown) {
  await page.evaluate((o) => {
    (window as unknown as BasherWindow)
      .__basher_dag!.getState()
      .dispatch(o, 'test', 'p204 camera tt');
  }, op);
}

async function lookThrough(page: import('@playwright/test').Page) {
  await page.keyboard.press('0');
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_viewport!.getState().lookThroughCamera,
    ),
  ).toBe(true);
}

async function viewCamAt(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time!.getState().setTime(s),
    seconds,
  );
  await page.waitForTimeout(150); // let a couple of frames apply the evaluated pose
  return page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera!());
}

test.describe('#204 camera Track-To (look-through)', () => {
  test('the look-through camera aims at a moving target == the constraint, ≥2 times', async ({
    page,
  }) => {
    await waitReady(page);
    // A target box that animates +X → +Z over [0,2], and a Track-To on the camera.
    await dispatch(page, {
      type: 'addNode',
      nodeId: TARGET_ID,
      nodeType: 'BoxMesh',
      params: { position: [10, 0, 0], size: [1, 1, 1] },
    });
    await dispatch(page, {
      type: 'connect',
      from: { node: TARGET_ID, socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    });
    await dispatch(page, {
      type: 'addNode',
      nodeId: 'n_cam_target_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'tgt',
        target: TARGET_ID,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [10, 0, 0], easing: 'linear' },
          { time: 2, value: [0, 0, 10], easing: 'linear' },
        ],
      },
    });
    await dispatch(page, {
      type: 'addNode',
      nodeId: 'n_cam_tt',
      nodeType: 'TrackTo',
      params: {
        name: 'camtt',
        target: 'n_camera',
        aimNode: TARGET_ID,
        aimPoint: [0, 0, 0],
        up: [0, 1, 0],
        mute: false,
      },
    });
    await lookThrough(page);

    for (const s of [
      { seconds: 0, targetPos: [10, 0, 0] as [number, number, number] },
      { seconds: 2, targetPos: [0, 0, 10] as [number, number, number] },
    ]) {
      const cam = await viewCamAt(page, s.seconds);
      expect(cam).not.toBeNull();
      const dir = norm(cam!.direction); // rendered forward (side A)
      const want = norm([
        s.targetPos[0] - cam!.position[0],
        s.targetPos[1] - cam!.position[1],
        s.targetPos[2] - cam!.position[2],
      ]);
      console.log(
        `[p204-cam t=${s.seconds}] dir=${JSON.stringify(dir.map((n) => +n.toFixed(3)))} want=${JSON.stringify(want.map((n) => +n.toFixed(3)))} pos=${JSON.stringify(cam!.position)}`,
      );
      // The look-through camera's forward points from its eye toward the target.
      expect(dir[0]).toBeCloseTo(want[0], 2);
      expect(dir[1]).toBeCloseTo(want[1], 2);
      expect(dir[2]).toBeCloseTo(want[2], 2);
    }
  });
});
