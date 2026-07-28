// UX #12 slice 1 — the camera inspector's Lens (Camera) section.
//
// Observes the REAL app (Lokayata): selecting a camera shows a dedicated Camera
// section with focal length / sensor / derived FOV / clipping (NOT the raw
// fov/near/far rows in the unrouted bucket), and editing the focal length
// drives the stored fov AND the live view camera's fov. Each behavioral
// assertion is falsifiable — reverting the routing / control makes it fail.

//
// ⚠️ #387 C4: the camera is SPLIT. The director still selects the camera `Object`
// (`n_camera`), but every lens param — focal/sensor/fov/near/far — now lives on its
// `CameraData` half, and `CameraLensControls` keys its testids to the node that OWNS the
// param it draws. So the ids below name the DATA half while the selection names the
// Object; that asymmetry IS the split, and reading it back through `dataNodeIdOf` rather
// than hardcoding `n_camera_data` keeps the spec addressing a wiring instead of a string.

import { test, expect } from './_fixtures';
import { dataNodeIdOf } from './_seedNodes';

interface W {
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_dag?: {
    getState: () => { state: { nodes: Record<string, { params: Record<string, unknown> }> } };
  };
  __basher_view_camera?: () => { fov: number } | null;
}

/** Select the camera Object, and return the id of the CameraData its lens rows key on. */
async function openCameraInspector(page: import('@playwright/test').Page): Promise<string> {
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
  return dataNodeIdOf(page, 'n_camera');
}

test.describe('#12 Blender-grade camera — lens section', () => {
  test('a camera shows the Camera section with focal/sensor/FOV/clipping', async ({ page }) => {
    const lens = await openCameraInspector(page);
    // The Camera section is the primary (first-declared) section.
    await expect(page.getByTestId('inspector-section-camera')).toBeVisible();
    await expect(page.getByTestId(`inspector-camera-focal-${lens}`)).toBeVisible();
    await expect(page.getByTestId(`inspector-camera-sensor-${lens}`)).toBeVisible();
    await expect(page.getByTestId(`inspector-camera-fov-${lens}`)).toBeVisible();
    await expect(page.getByTestId(`inspector-camera-near-${lens}`)).toBeVisible();
    await expect(page.getByTestId(`inspector-camera-far-${lens}`)).toBeVisible();
    // The raw fov param row no longer leaks into the unrouted bucket (falsify:
    // drop the camera routing → fov renders as inspector-input-<lens>-fov).
    //
    // Keyed to the LENS half deliberately. `fov` is a CameraData param, so the generic row
    // it would fall back to is `inspector-input-n_camera_data-fov`; asserting count 0 for
    // the Object's id would be an assertion about a testid the app can no longer emit under
    // any circumstances — a negative that passes because it can never fail.
    await expect(page.getByTestId(`inspector-input-${lens}-fov`)).toHaveCount(0);
  });

  test('editing focal length drives the stored fov and the live view camera', async ({ page }) => {
    const lens = await openCameraInspector(page);
    // 18mm on a 36mm sensor → fov = 2·atan(36/36) = 90°.
    const focal = page.getByTestId(`inspector-camera-focal-${lens}`);
    await focal.fill('18');
    await focal.blur();
    await expect(page.getByTestId(`inspector-camera-fov-${lens}`)).toHaveText('90°');
    const fov = await page.evaluate((id) => {
      const w = window as unknown as W;
      return {
        // The stored `fov` is on the CameraData half; reading `n_camera.params.fov` would
        // find nothing and report the control as broken (#423: a wrong-half read is quiet).
        param: w.__basher_dag!.getState().state.nodes[id].params.fov,
        view: w.__basher_view_camera!()?.fov,
      };
    }, lens);
    expect(fov.param).toBeCloseTo(90, 1);
    expect(fov.view).toBeCloseTo(90, 1); // the live viewport adopted the new lens
  });
});
