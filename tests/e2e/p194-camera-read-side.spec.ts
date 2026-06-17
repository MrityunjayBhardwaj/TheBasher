// #194 — camera inspector READ-SIDE parity (the last H104 instance). The camera
// already ANIMATES end-to-end (#190): a free-floating KeyframeChannel* targets
// n_camera and resolveActiveCameraPoseAt overlays it, so the look-through view
// camera follows the keyed value. But CameraLensControls is a CUSTOM inspector
// control (not a generic ParamRow), so it read node.params.fov directly — during
// playback/scrub its focal-length / field-of-view / near / far fields froze at the
// authored value while the render followed the channel (H104 / H40).
//
// These tests drive the boundary PAIR (Lokayata): inject a fov / near channel onto
// n_camera via __basher_dag, scrub the playhead, and assert the inspector field
// (READ side, DOM) == the look-through view camera (RENDER side,
// resolveActiveCameraPoseAt) at the same time T. Falsifiable: revert the
// resolveEvaluatedParam read in CameraLensControls → the inspector freezes at the
// static authored fov while the view camera still moves → the read==render
// equality breaks at t=1.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_view_camera?: () => {
    position: [number, number, number];
    fov: number | null;
    near: number;
    far: number;
    lookThrough: boolean;
  } | null;
  __basher_viewport?: { getState: () => { lookThroughCamera: boolean } };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown, source: string, desc: string) => void;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_view_camera &&
      w.__basher_viewport &&
      w.__basher_time &&
      w.__basher_dag &&
      w.__basher_selection,
    );
  });
  await page.waitForTimeout(300);
}

/** Inject a KeyframeChannel* targeting n_camera — the #190 free-floating shape. */
async function addCameraChannel(
  page: import('@playwright/test').Page,
  nodeId: string,
  nodeType: 'KeyframeChannelVec3' | 'KeyframeChannelNumber',
  paramPath: string,
  keyframes: unknown[],
) {
  await page.evaluate(
    ({ nodeId, nodeType, paramPath, keyframes }) => {
      (window as unknown as BasherWindow).__basher_dag!.getState().dispatch(
        {
          type: 'addNode',
          nodeId,
          nodeType,
          params: { name: paramPath, target: 'n_camera', paramPath, keyframes },
        },
        'test',
        'inject camera channel',
      );
    },
    { nodeId, nodeType, paramPath, keyframes },
  );
}

async function selectCamera(page: import('@playwright/test').Page) {
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_selection!.getState().select('n_camera'),
  );
  await expect(page.getByTestId('inspector-section-camera')).toBeVisible();
}

async function lookThrough(page: import('@playwright/test').Page) {
  await page.keyboard.press('0');
  await page.waitForTimeout(200);
  const lt = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_viewport!.getState().lookThroughCamera,
  );
  expect(lt).toBe(true);
}

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time!.getState().setTime(s),
    seconds,
  );
  await page.waitForTimeout(150); // let the inspector re-render + a couple of frames apply the pose
}

function viewCam(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera!());
}

test.describe('#194 camera inspector read-side parity', () => {
  test('the FOV readout tracks the keyed channel during scrub (read == look-through render)', async ({
    page,
  }) => {
    await waitReady(page);
    // fov 20° at t=0 → 80° at t=1 (linear).
    await addCameraChannel(page, 'cam_fov_ch', 'KeyframeChannelNumber', 'fov', [
      { time: 0, value: 20, easing: 'linear' },
      { time: 1, value: 80, easing: 'linear' },
    ]);
    await selectCamera(page);
    await lookThrough(page);

    const fovText = page.getByTestId('inspector-camera-fov-n_camera');
    const focal = page.getByTestId('inspector-camera-focal-n_camera');

    // t=0 — the inspector shows the EVALUATED fov (20°), and it equals the render.
    await setTime(page, 0);
    await expect(fovText).toHaveText('20°');
    const focal0 = await focal.inputValue();
    expect((await viewCam(page))!.fov).toBeCloseTo(20, 0);

    // t=1 — the inspector FOLLOWED the channel to 80° (the falsifiable signal: a
    // frozen read side would still read 20°), still matching the render.
    await setTime(page, 1);
    await expect(fovText).toHaveText('80°');
    const focal1 = await focal.inputValue();
    expect((await viewCam(page))!.fov).toBeCloseTo(80, 0);

    // The focal-length readout is derived from the EVALUATED fov, so it moved too
    // (wider fov → shorter focal length).
    expect(Number(focal0)).not.toBeCloseTo(Number(focal1), 1);
    expect(Number(focal1)).toBeLessThan(Number(focal0));
  });

  test('the near-clip field tracks its keyed channel during scrub', async ({ page }) => {
    await waitReady(page);
    await addCameraChannel(page, 'cam_near_ch', 'KeyframeChannelNumber', 'near', [
      { time: 0, value: 0.5, easing: 'linear' },
      { time: 1, value: 4, easing: 'linear' },
    ]);
    await selectCamera(page);

    const near = page.getByTestId('inspector-camera-near-n_camera');

    await setTime(page, 0);
    expect(Number(await near.inputValue())).toBeCloseTo(0.5, 1);

    await setTime(page, 1);
    // Falsifiable: a frozen read side stays at the authored 0.1 / 0.5.
    expect(Number(await near.inputValue())).toBeCloseTo(4, 1);
  });
});
