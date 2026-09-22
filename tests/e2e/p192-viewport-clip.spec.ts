// #192 — manual VIEWPORT clip override (View ▸ Clip Start/End). The free editor
// view uses Blender's default clip, 0.01–1000 (#1178); a manual override replaces
// it WITHOUT touching the scene camera node, and persists per project across
// reloads. Clearing it (View ▸ Clipping ▸ Default) means the default before AND
// after a reload (#1187).
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
  await page.waitForTimeout(400); // let the boot framing settle
}

test.describe('#192 viewport clip override', () => {
  test('a manual override replaces the default planes; clearing restores the default', async ({
    page,
  }) => {
    await waitReady(page);

    // The default: Blender's viewport clip, not the override values we are
    // about to set.
    const dflt = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(dflt).not.toBeNull();
    expect(dflt!.near).toBeCloseTo(0.01, 5);
    expect(dflt!.far).toBeCloseTo(1000, 5);

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

    // Clear → back to the default.
    await page.evaluate(() => {
      (window as unknown as BasherWindow)
        .__basher_viewport!.getState()
        .setViewportClipOverride(null);
    });
    await page.waitForTimeout(150);
    const cleared = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cleared!.near).toBeCloseTo(0.01, 5);
    expect(cleared!.far).toBeCloseTo(1000, 5);
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
    // Reverting the hydration effect → planes stay default → far ≠ 42 → fails.
    expect(cam!.near).toBeCloseTo(3, 3);
    expect(cam!.far).toBeCloseTo(42, 3);
  });

  test('View ▸ Clipping ▸ Clip End sets + persists the far plane; Default clears it', async ({
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

    // View ▸ Clipping ▸ Default → clears the override AND the persisted entry.
    await page.getByTestId('menu-view-button').click();
    await page.getByTestId('menu-view-clipping').hover();
    await page.getByTestId('menu-view-clip-default').click();
    await page.waitForTimeout(150);

    const cleared = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cleared!.far).toBeCloseTo(1000, 5);
    const afterClear = await page.evaluate(() => {
      const id = localStorage.getItem('basher.lastProjectId')!;
      return localStorage.getItem('basher.viewportClip.' + id);
    });
    expect(afterClear).toBeNull();

    // #1187 — and a reload answers the SAME: the default, with no override
    // standing in the store. Before, the session's cleared value meant the
    // bounds-fit while a reload hydrated the fixed clip, so the two disagreed.
    await waitReady(page);
    const reloaded = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return {
        cam: w.__basher_view_camera!(),
        override: (
          w.__basher_viewport!.getState() as unknown as {
            viewportClipOverride: unknown;
          }
        ).viewportClipOverride,
      };
    });
    expect(reloaded.cam!.near).toBeCloseTo(0.01, 5);
    expect(reloaded.cam!.far).toBeCloseTo(1000, 5);
    expect(reloaded.override).toBeNull();
  });
});
