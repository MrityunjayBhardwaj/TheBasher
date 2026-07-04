// #250 — viewport pick priority: clicking a scene object selects THAT object
// (not a camera frustum in front of it), and clicking empty space clears the
// selection. Before the fix the default camera's frustum WIREFRAME was raycast
// via the line-threshold; the editor eye sits on the camera's apex→lookAt axis,
// so its edges scored near-zero-distance hits that out-picked the framed cube
// (clicking the cube selected n_camera) and blanketed "empty" screen so deselect
// never fired. The frustum visuals are now non-pickable; the compact body icon
// is the sole camera pick surface (Blender parity, covered by p165).
//
// Falsifiable: re-enable the frustum line raycast → the center click selects
// n_camera and the empty click never clears → both assertions below fail.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_selection?: {
    getState: () => {
      primaryNodeId: string | null;
      select: (id: string | null) => void;
      clear: () => void;
    };
  };
  __basher_dag?: { getState: () => unknown };
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_selection && w.__basher_dag);
  });
  await page.waitForTimeout(400);
}

function primary(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => (window as unknown as BasherWindow).__basher_selection!.getState().primaryNodeId,
  );
}

test.describe('#250 viewport pick priority', () => {
  test('clicking the framed cube selects the cube, not the camera in front of it', async ({
    page,
  }) => {
    await waitReady(page);
    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;

    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_selection!.getState().clear(),
    );
    // The default scene frames the cube at the viewport center.
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.waitForTimeout(150);
    expect(await primary(page)).toBe('n_box');
  });

  test('clicking empty space clears the selection', async ({ page }) => {
    await waitReady(page);
    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;

    // Select the cube, then click empty canvas (offset right of the small cube,
    // away from the edge islands). onPointerMissed must fire → selection clears.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box'),
    );
    expect(await primary(page)).toBe('n_box');
    await canvas.click({ position: { x: box.width / 2 + 220, y: box.height / 2 } });
    await page.waitForTimeout(150);
    expect(await primary(page)).toBeNull();
  });
});
