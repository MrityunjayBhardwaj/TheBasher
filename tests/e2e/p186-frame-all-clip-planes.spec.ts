// #186 — full bounds-fit on load scales the FRAMING to the model size, so a very
// large model does not fall off-screen. #1178 — the CLIP does not follow it: the
// free view keeps Blender's default 0.01–1000 whatever the scene's size, and
// #1188 says so when the scene reaches past Clip End, naming where the fix is.
//
// Observes the REAL R3F canvas (Lokayata): grow the seed box to 4000 units, then
// duplicate the project (a fresh id with no saved view → the bounds-fit settle
// runs on the new project) and assert the editor view dollies WAY out to frame
// it, the clip stays the default, and the notice shows — then raise Clip End and
// watch the notice go. Falsifiable: revert the bounds-fit → the eye stays at the
// small-box framing; drop the reach check → no notice; derive the clip from the
// bounds again → far ≠ 1000.

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
  __basher_viewport?: {
    getState: () => {
      setViewportClipOverride: (c: { near: number; far: number } | null) => void;
    };
  };
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_view_camera && w.__basher_dag && w.__basher_viewport);
  });
  await page.waitForTimeout(300);
}

test.describe('#186 frame-all clip planes', () => {
  test('a large model is framed, the clip stays the default, and the view says it reaches past Clip End', async ({
    page,
  }) => {
    await waitReady(page);
    const notice = page.getByTestId('viewport-clip-notice');
    // Control: the seed's unit box sits well inside 1000 → no notice.
    await page.waitForTimeout(400);
    await expect(notice).toHaveCount(0);

    // Grow the seed box to 4000 units — far past the default far = 1000.
    await page.evaluate(() => {
      const api = (window as unknown as BasherWindow).__basher_dag!.getState();
      api.dispatch({
        type: 'setParam',
        nodeId: 'n_box_data',
        paramPath: 'size',
        value: [4000, 4000, 4000],
      });
    });
    // The size lives on the box's DATA node since the Object/data split; a
    // setParam on the Object is rejected silently, which left this spec testing
    // a unit box. Read the edit back so a rejected one fails here instead.
    const grown = await page.evaluate(
      () =>
        (
          (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[
            'n_box_data'
          ] as unknown as { params: { size: number[] } }
        ).params.size,
    );
    expect(grown).toEqual([4000, 4000, 4000]);
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
    // The clip did NOT follow: Blender's default, whatever the scene (#1178).
    expect(cam!.near).toBeCloseTo(0.01, 5);
    expect(cam!.far).toBeCloseTo(1000, 5);
    expect(cam!.lookThrough).toBe(false);
    // ...and the view says so, naming the number and where to change it (#1188).
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Clip End (1000)');
    await expect(notice).toContainText('View ▸ Clipping');

    // Raise Clip End past the scene's reach → the notice goes.
    await page.evaluate(() => {
      (window as unknown as BasherWindow)
        .__basher_viewport!.getState()
        .setViewportClipOverride({ near: 0.01, far: 20000 });
    });
    await expect(notice).toHaveCount(0);
    const raised = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(raised!.far).toBeCloseTo(20000, 3);
  });
});
