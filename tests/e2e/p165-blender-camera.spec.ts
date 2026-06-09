// #165 — Blender-style camera: the editor view is decoupled from the DAG
// scene camera, cameras render as selectable wireframe frustums, and
// "look through camera" (Numpad 0) previews the production framing.
//
// These tests observe the REAL R3F canvas (Lokayata): the boot framing, a
// real pointer click on a frustum routing selection to the camera NODE, the
// look-through keybind flipping the view camera's pose, and per-project view
// persistence across reload. Each behavioral test is falsifiable — reverting
// the feature makes the assertion fail (noted per test).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_view_camera?: () => {
    position: [number, number, number];
    fov: number;
    near: number;
    far: number;
    lookThrough: boolean;
  } | null;
  __basher_project_ndc?: (xyz: [number, number, number]) => [number, number, number] | null;
  __basher_selection?: { getState: () => { primaryNodeId: string | null; clear: () => void } };
  __basher_viewport?: { getState: () => { lookThroughCamera: boolean } };
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown, source: string, desc: string) => void;
    };
  };
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_view_camera &&
      w.__basher_project_ndc &&
      w.__basher_selection &&
      w.__basher_viewport &&
      w.__basher_dag,
    );
  });
  // Let the first frame paint so the camera ref + matrices are live.
  await page.waitForTimeout(300);
}

test.describe('#165 Blender-style camera', () => {
  test('boots the editor view at the active camera pose, not looking through', async ({ page }) => {
    await waitReady(page);
    const cam = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cam).not.toBeNull();
    // Byte-identical to the pre-#165 makeDefault DAG camera (default.ts seed).
    expect(cam!.position[0]).toBeCloseTo(3, 1);
    expect(cam!.position[1]).toBeCloseTo(2, 1);
    expect(cam!.position[2]).toBeCloseTo(3, 1);
    expect(cam!.fov).toBeCloseTo(45, 1);
    expect(cam!.lookThrough).toBe(false);
  });

  test('clicking a camera frustum in the viewport selects the camera node', async ({ page }) => {
    await waitReady(page);

    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;

    // The active camera's apex is at [3,2,3] (the boot eye); its frustum hitbox
    // sits ~0.45u in front, toward its lookAt (origin). Project a point inside
    // that hitbox volume (apex nudged toward origin) — it is NEARER the eye than
    // the cube at the origin, so the raycast targets the frustum, not the mesh.
    const ndcCam = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_project_ndc!([2.7, 1.8, 2.7]),
    );
    expect(ndcCam).not.toBeNull();
    expect(ndcCam![2]).toBeLessThan(1); // in front of the camera
    expect(Math.abs(ndcCam![0])).toBeLessThan(0.95);
    expect(Math.abs(ndcCam![1])).toBeLessThan(0.95);

    // Clear selection so the assertion can't pass on stale state.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_selection!.getState().clear(),
    );

    const px = box.x + ((ndcCam![0] + 1) / 2) * box.width;
    const py = box.y + ((1 - ndcCam![1]) / 2) * box.height;
    await page.mouse.click(px, py);
    await page.waitForTimeout(150);

    // The frustum click routed selection to the camera NODE (the #165 fix).
    // Revert CameraHelpers (no frustum) → the click hits empty space →
    // onPointerMissed clears selection → primaryNodeId is null → this fails.
    const selected = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_selection!.getState().primaryNodeId,
    );
    expect(selected).toBe('n_camera');
  });

  test('Numpad 0 looks through the active camera and adopts its pose', async ({ page }) => {
    await waitReady(page);

    // Orbit away so the view camera is NOT at the active camera's pose.
    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 220, cy + 40, { steps: 16 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const before = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    // We orbited off [3,2,3].
    const movedAway =
      Math.hypot(before!.position[0] - 3, before!.position[1] - 2, before!.position[2] - 3) > 0.5;
    expect(movedAway).toBe(true);

    // Press 0 — look through the active camera.
    await page.keyboard.press('0');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(after!.lookThrough).toBe(true);
    // The view adopts the active camera's pose [3,2,3] (production framing).
    // Revert Wave B's adopt-on-lookThrough → position stays at the orbited spot → fails.
    expect(after!.position[0]).toBeCloseTo(3, 1);
    expect(after!.position[1]).toBeCloseTo(2, 1);
    expect(after!.position[2]).toBeCloseTo(3, 1);

    // The CAMERA VIEW badge is visible while looking through.
    await expect(page.getByTestId('camera-view-badge')).toBeVisible();

    // Press 0 again — exit camera view.
    await page.keyboard.press('0');
    await page.waitForTimeout(150);
    const exited = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(exited!.lookThrough).toBe(false);
  });

  test('the editor orbit view persists across reload (per project)', async ({ page }) => {
    await waitReady(page);

    // Orbit, which fires OrbitControls onEnd → saveEditorView on mouseup.
    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 240, cy + 70, { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const saved = await page.evaluate(() => localStorage.getItem('basher.editorView.default'));
    expect(saved).not.toBeNull();
    const savedPose = JSON.parse(saved!) as { position: [number, number, number] };

    // Reload — same origin, localStorage persists.
    await page.reload();
    await page.waitForFunction(() =>
      Boolean((window as unknown as BasherWindow).__basher_view_camera),
    );
    await page.waitForTimeout(500);

    const restored = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_view_camera!().position,
    );
    // Restored to the EXACT saved pose (not the default [3,2,3]).
    // Revert Wave E → boot ignores localStorage → snaps to [3,2,3] → fails.
    expect(restored[0]).toBeCloseTo(savedPose.position[0], 2);
    expect(restored[1]).toBeCloseTo(savedPose.position[1], 2);
    expect(restored[2]).toBeCloseTo(savedPose.position[2], 2);
    const distFromDefault = Math.hypot(restored[0] - 3, restored[1] - 2, restored[2] - 3);
    expect(distFromDefault).toBeGreaterThan(0.5);
  });
});
