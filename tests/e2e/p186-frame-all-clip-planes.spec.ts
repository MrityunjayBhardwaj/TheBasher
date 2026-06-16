// #186 — full bounds-fit on load scales the FRAMING and the CLIP PLANES to the
// model size, so a very large model neither falls off-screen nor clips at the
// far plane (the old fixed 0.1/1000 would clip anything past 1000 units).
//
// Observes the REAL R3F canvas (Lokayata): grow the seed box to 4000 units,
// then duplicate the project (a fresh id with no saved view → the bounds-fit
// settle runs on the new project) and assert the editor view dollies WAY out to
// frame it AND the far plane grows past the old 1000 constant. Falsifiable:
// revert the bounds-fit → far stays 1000 and the eye stays at the small-box
// framing → both assertions fail (and a 4000-unit box would clip at far).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_view_camera?: () => {
    position: [number, number, number];
    near: number;
    far: number;
    lookThrough: boolean;
  } | null;
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: { nodes: Record<string, { type: string }> };
    };
  };
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_view_camera && w.__basher_dag);
  });
  await page.waitForTimeout(300);
}

test.describe('#186 frame-all clip planes', () => {
  test('a large model is framed and the far plane scales past the old 1000', async ({ page }) => {
    await waitReady(page);

    // Grow the seed box to 4000 units — far larger than the old fixed far=1000.
    await page.evaluate(() => {
      const api = (window as unknown as BasherWindow).__basher_dag!.getState();
      api.dispatch({
        type: 'setParam',
        nodeId: 'n_box',
        paramPath: 'size',
        value: [4000, 4000, 4000],
      });
    });
    await page.waitForTimeout(100);

    // Duplicate → a fresh project id (no saved view) → the bounds-fit settle
    // runs on the new project, which carries the grown box.
    const before = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
    await page.getByTestId('menu-file').click();
    await page.getByTestId('menu-file-duplicate').click();
    await page.waitForFunction(
      (prev) => localStorage.getItem('basher.lastProjectId') !== prev,
      before,
    );
    // Allow the settle loop to converge on the (sync) large box.
    await page.waitForTimeout(800);

    const cam = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cam).not.toBeNull();
    // The eye dollied WAY out to frame the 4000-unit box (radius ~3464) — far
    // beyond the small-box framing (~3) and the authored eye (~4.7).
    const dist = Math.hypot(cam!.position[0], cam!.position[1], cam!.position[2]);
    expect(dist).toBeGreaterThan(1000);
    // The far plane scaled with the bounds — it CLEARS the model instead of
    // clamping at the old fixed 1000 (which would clip most of a 4000-unit box).
    expect(cam!.far).toBeGreaterThan(2000);
    // near stayed positive and bounded away from zero (no z-fight, no clip).
    expect(cam!.near).toBeGreaterThan(0);
    expect(cam!.far / cam!.near).toBeLessThanOrEqual(50_001);
    expect(cam!.lookThrough).toBe(false);
  });
});
