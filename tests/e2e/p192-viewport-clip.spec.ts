// #192 — manual VIEWPORT clip override (View ▸ Clip Start/End). The free editor
// view derives near/far from the scene bounds by default (#186/#191); a manual
// override replaces those WITHOUT touching the scene camera node, and persists
// per project across reloads.
//
// Observes the REAL R3F camera (Lokayata) via __basher_view_camera, and drives
// the store/persistence via the __basher_viewport DEV seam (the menu UI is
// exercised in p192's menu test; this pins the camera wiring + hydration).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_view_camera?: () => { near: number; far: number; lookThrough: boolean } | null;
  __basher_viewport?: {
    getState: () => {
      setViewportClipOverride: (c: { near: number; far: number } | null) => void;
      viewportClipReadout: { near: number; far: number };
    };
  };
  __basher_dag?: unknown;
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_view_camera && w.__basher_viewport && w.__basher_dag);
  });
  await page.waitForTimeout(400); // let the bounds-fit settle converge
}

test.describe('#192 viewport clip override', () => {
  test('a manual override replaces the auto planes; clearing restores auto', async ({ page }) => {
    await waitReady(page);

    // Auto (default): the seed box frames with bounds-derived planes — NOT the
    // override values we are about to set.
    const auto = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(auto).not.toBeNull();
    expect(auto!.near).not.toBeCloseTo(7, 1);
    expect(auto!.far).not.toBeCloseTo(99, 1);

    // Set a manual override → the live viewport camera adopts exactly it.
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_viewport!.getState().setViewportClipOverride({
        near: 7,
        far: 99,
      });
    });
    await page.waitForTimeout(150);
    const overridden = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(overridden!.near).toBeCloseTo(7, 3);
    expect(overridden!.far).toBeCloseTo(99, 3);

    // The readout reflects the effective (override) planes for the menu.
    const readout = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_viewport!.getState().viewportClipReadout,
    );
    expect(readout.near).toBeCloseTo(7, 3);
    expect(readout.far).toBeCloseTo(99, 3);

    // Clear → back to AUTO (no longer the override values).
    await page.evaluate(() => {
      (window as unknown as BasherWindow)
        .__basher_viewport!.getState()
        .setViewportClipOverride(null);
    });
    await page.waitForTimeout(150);
    const cleared = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cleared!.far).not.toBeCloseTo(99, 1);
  });

  test('a persisted override is hydrated on reload (per project)', async ({ page }) => {
    await waitReady(page);

    // Persist an override for the current project directly (the menu handler
    // does this; here we pin the hydrate-on-boot path), then reload.
    await page.evaluate(() => {
      const id = localStorage.getItem('basher.lastProjectId')!;
      localStorage.setItem('basher.viewportClip.' + id, JSON.stringify({ near: 3, far: 42 }));
    });

    await waitReady(page);
    const cam = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    // Reverting the hydration effect → planes stay auto → far ≠ 42 → fails.
    expect(cam!.near).toBeCloseTo(3, 3);
    expect(cam!.far).toBeCloseTo(42, 3);
  });

  test('View ▸ Clipping ▸ Clip End sets + persists the far plane; Auto clears it', async ({
    page,
  }) => {
    await waitReady(page);

    // Drive the real menu: View ▸ Clipping ▸ Clip End… → prompt → accept "250".
    page.once('dialog', (d) => void d.accept('250'));
    await page.getByTestId('menu-view-button').click();
    await page.getByTestId('menu-view-clipping').hover();
    await page.getByTestId('menu-view-clip-end').click();
    await page.waitForTimeout(150);

    const cam = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cam!.far).toBeCloseTo(250, 3);

    // Persisted for this project (the menu handler saves to localStorage).
    const saved = await page.evaluate(() => {
      const id = localStorage.getItem('basher.lastProjectId')!;
      return localStorage.getItem('basher.viewportClip.' + id);
    });
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).far).toBeCloseTo(250, 3);

    // View ▸ Clipping ▸ Auto → clears the override AND the persisted entry.
    await page.getByTestId('menu-view-button').click();
    await page.getByTestId('menu-view-clipping').hover();
    await page.getByTestId('menu-view-clip-auto').click();
    await page.waitForTimeout(150);

    const cleared = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cleared!.far).not.toBeCloseTo(250, 1);
    const afterClear = await page.evaluate(() => {
      const id = localStorage.getItem('basher.lastProjectId')!;
      return localStorage.getItem('basher.viewportClip.' + id);
    });
    expect(afterClear).toBeNull();
  });
});
