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
  test('boots the editor view framing the scene bounds, not looking through', async ({ page }) => {
    await waitReady(page);
    const cam = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cam).not.toBeNull();
    // #186 — FULL bounds-fit on load: the editor view frames the scene's
    // bounding sphere (the default seed's 1×1×1 box at origin) along the
    // canonical [3,2,3] viewing angle — NOT the authored camera eye [3,2,3].
    const p = cam!.position;
    const dist = Math.hypot(p[0], p[1], p[2]);
    // Same 3/4 viewing angle (normalized [3,2,3]) — only the DISTANCE scales
    // to the bounds.
    const len = Math.hypot(3, 2, 3);
    expect(p[0] / dist).toBeCloseTo(3 / len, 1);
    expect(p[1] / dist).toBeCloseTo(2 / len, 1);
    expect(p[2] / dist).toBeCloseTo(3 / len, 1);
    // Framing the unit box pulls the eye IN to ~2.9, not the authored 4.69.
    expect(dist).toBeGreaterThan(1.5);
    expect(dist).toBeLessThan(4.0);
    // The headline #186 fix: clip planes are BOUNDS-DERIVED, not the old
    // 0.1/1000 constants (so large models no longer clip at far). Revert the
    // bounds-fit → near 0.1 / far 1000 → these two fail.
    expect(cam!.far).toBeLessThan(50);
    expect(cam!.near).toBeGreaterThan(0.5);
    expect(cam!.fov).toBeCloseTo(45, 1);
    expect(cam!.lookThrough).toBe(false);
  });

  test('clicking a camera frustum in the viewport selects the camera node', async ({ page }) => {
    await waitReady(page);

    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;

    // #186 — the view now boots framing the box (bounds-fit), so the camera
    // object at [3,2,3] starts BEHIND the eye. Dolly out (wheel) until its
    // BODY is in front and on-screen, then click it. #250 — selection is via the
    // camera's body/icon at the apex [3,2,3] (Blender parity), not the frustum
    // cone interior: the wireframe is now a pure visual (its line-threshold hits
    // used to hijack clicks meant for the framed subject), so aim at the apex.
    const cx0 = box.x + box.width / 2;
    const cy0 = box.y + box.height / 2;
    await page.mouse.move(cx0, cy0);
    let ndcCam: [number, number, number] | null = null;
    for (let i = 0; i < 20; i++) {
      ndcCam = await page.evaluate(() =>
        (window as unknown as BasherWindow).__basher_project_ndc!([3, 2, 3]),
      );
      if (ndcCam && ndcCam[2] < 1 && Math.abs(ndcCam[0]) < 0.9 && Math.abs(ndcCam[1]) < 0.9) break;
      await page.mouse.wheel(0, 240); // dolly out, past the camera apex
      await page.waitForTimeout(80);
    }
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
