// #191 — the SAVED-VIEW reload path on a large scene.
//
// A saved orbit view (reload / per-project restore) keeps its exact pose — it
// is not re-framed. #1178 — the clip is Blender's fixed 0.01–1000 unless the
// user sets their own, which survives the reload; #1188 — the view says when the
// scene reaches past Clip End.
//
// Observes the REAL R3F canvas (Lokayata): grow the box to 4000, duplicate so a
// fresh project PERSISTS the grown box, inject a CLOSE saved view, reload, then
// assert (a) the eye stays at the saved CLOSE pose — NOT re-framed — (b) the
// clip is the default and the notice shows; then persist a raised Clip End,
// reload again, and assert (c) the pose still holds, far is the user's, and the
// notice is gone. Falsifiable: a "run the full fit" regression → the eye dollies
// out to ~5800 → (a) fails; drop the clip hydration → far stays 1000 → (c) fails.

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

test.describe('#191 saved-view clip planes', () => {
  test('a restored saved view keeps its pose; the clip is the default until raised, and the raise survives a reload', async ({
    page,
  }) => {
    await waitReady(page);

    // Grow the seed box to 4000 units (radius ~3464) — past the default far = 1000.
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

    // Duplicate → a fresh project id whose file PERSISTS the grown box (so the
    // reload below restores a 4000-unit scene, not the default small box).
    const before = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
    await page.getByTestId('menu-file').click();
    await page.getByTestId('menu-file-duplicate').click();
    await page.waitForFunction(
      (prev) => localStorage.getItem('basher.lastProjectId') !== prev,
      before,
    );

    // Inject a CLOSE saved orbit view for the duplicated project (~distance 6.4
    // from the origin) — deliberately NOT a framing distance, so "pose
    // preserved" is distinguishable from "re-framed to fit".
    const savedDist = await page.evaluate(() => {
      const id = localStorage.getItem('basher.lastProjectId')!;
      const view = { position: [4, 3, 4] as [number, number, number], target: [0, 0, 0] };
      localStorage.setItem('basher.editorView.' + id, JSON.stringify(view));
      return Math.hypot(view.position[0], view.position[1], view.position[2]);
    });

    // Reload → boot restores the 4000-unit project AND loads the saved view.
    await waitReady(page);
    await page.waitForTimeout(800); // let the limits-only settle converge

    const notice = page.getByTestId('viewport-clip-notice');
    const cam = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cam).not.toBeNull();
    // (a) Pose PRESERVED — the eye stays at the saved close pose.
    const dist = Math.hypot(cam!.position[0], cam!.position[1], cam!.position[2]);
    expect(dist).toBeCloseTo(savedDist, 1);
    // (b) The default clip, and the scene's far corners (~3400 deep along the
    // view) reach past it — the view says so.
    expect(cam!.near).toBeCloseTo(0.01, 5);
    expect(cam!.far).toBeCloseTo(1000, 5);
    expect(cam!.lookThrough).toBe(false);
    await expect(notice).toBeVisible();

    // The user raises Clip End (what View ▸ Clipping saves), then reloads.
    await page.evaluate(() => {
      const id = localStorage.getItem('basher.lastProjectId')!;
      localStorage.setItem('basher.viewportClip.' + id, JSON.stringify({ near: 0.01, far: 5000 }));
    });
    await waitReady(page);
    await page.waitForTimeout(800);

    // (c) Pose still preserved, far is the user's, the notice is gone.
    const raised = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    const dist2 = Math.hypot(raised!.position[0], raised!.position[1], raised!.position[2]);
    expect(dist2).toBeCloseTo(savedDist, 1);
    expect(raised!.far).toBeCloseTo(5000, 3);
    await expect(notice).toHaveCount(0);
  });
});
