// UX #12 slice 1 — the camera inspector's Lens (Camera) section.
//
// Observes the REAL app (Lokayata): selecting a camera shows a dedicated Camera
// section with focal length / sensor / derived FOV / clipping (NOT the raw
// fov/near/far rows in the unrouted bucket), and editing the focal length
// drives the stored fov AND the live view camera's fov. Each behavioral
// assertion is falsifiable — reverting the routing / control makes it fail.

import { test, expect } from './_fixtures';

interface W {
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_dag?: {
    getState: () => { state: { nodes: Record<string, { params: Record<string, unknown> }> } };
  };
  __basher_view_camera?: () => { fov: number } | null;
}

async function openCameraInspector(page: import('@playwright/test').Page) {
  await page.goto('/');
  const starter = page.getByText('Starter Scene').first();
  if (await starter.count()) await starter.click().catch(() => {});
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_selection && w.__basher_dag && w.__basher_view_camera);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection!.getState().select('n_camera'),
  );
}

test.describe('#12 Blender-grade camera — lens section', () => {
  test('a camera shows the Camera section with focal/sensor/FOV/clipping', async ({ page }) => {
    await openCameraInspector(page);
    // The Camera section is the primary (first-declared) section.
    await expect(page.getByTestId('inspector-section-camera')).toBeVisible();
    await expect(page.getByTestId('inspector-camera-focal-n_camera')).toBeVisible();
    await expect(page.getByTestId('inspector-camera-sensor-n_camera')).toBeVisible();
    await expect(page.getByTestId('inspector-camera-fov-n_camera')).toBeVisible();
    await expect(page.getByTestId('inspector-camera-near-n_camera')).toBeVisible();
    await expect(page.getByTestId('inspector-camera-far-n_camera')).toBeVisible();
    // The raw fov param row no longer leaks into the unrouted bucket (falsify:
    // drop the camera routing → fov renders as inspector-input-n_camera-fov).
    await expect(page.getByTestId('inspector-input-n_camera-fov')).toHaveCount(0);
  });

  test('editing focal length drives the stored fov and the live view camera', async ({ page }) => {
    await openCameraInspector(page);
    // 18mm on a 36mm sensor → fov = 2·atan(36/36) = 90°.
    const focal = page.getByTestId('inspector-camera-focal-n_camera');
    await focal.fill('18');
    await focal.blur();
    await expect(page.getByTestId('inspector-camera-fov-n_camera')).toHaveText('90°');
    const fov = await page.evaluate(() => {
      const w = window as unknown as W;
      return {
        param: w.__basher_dag!.getState().state.nodes.n_camera.params.fov,
        view: w.__basher_view_camera!()?.fov,
      };
    });
    expect(fov.param).toBeCloseTo(90, 1);
    expect(fov.view).toBeCloseTo(90, 1); // the live viewport adopted the new lens
  });
});
