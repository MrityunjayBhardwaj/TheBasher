// #191 — bounds-derived clip planes on the SAVED-VIEW reload path.
//
// #186 scaled near/far + dolly limits to the model on the bounds-fit branch
// only. A saved orbit view (reload / per-project restore) restored the pose but
// kept the fixed near=0.1 / far=1000 — so a large model you orbit then reload
// clips at `far` again. #191 runs a PLANES-ONLY settle on that branch: keep the
// saved pose, but re-derive near/far from the live camera distance to the
// bounds.
//
// Observes the REAL R3F canvas (Lokayata): grow the box to 4000, duplicate so a
// fresh project PERSISTS the grown box, inject a CLOSE saved view, reload, then
// assert the editor camera (a) stays at the saved CLOSE pose — NOT re-framed —
// and (b) far grows past the old 1000 to clear the model. Falsifiable two ways:
// revert #191 → far stays 1000 (clips) → (b) fails; a wrong "run the full fit"
// fix → the eye dollies out to ~5800 → (a) fails.

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
  test('a restored saved view keeps its pose AND derives far from the bounds', async ({ page }) => {
    await waitReady(page);

    // Grow the seed box to 4000 units (radius ~3464) — far past the old far=1000.
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

    // Reload → boot restores the 4000-unit project AND loads the saved view →
    // the planes-only settle (#191) runs.
    await waitReady(page);
    await page.waitForTimeout(800); // let the planes-only settle converge

    const cam = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(cam).not.toBeNull();

    // (a) Pose PRESERVED — the eye stays at the saved close pose, NOT dollied
    // out to frame the box (~5800). Proves the settle is planes-ONLY.
    const dist = Math.hypot(cam!.position[0], cam!.position[1], cam!.position[2]);
    expect(dist).toBeCloseTo(savedDist, 1);

    // (b) far is BOUNDS-DERIVED — it clears the 4000-unit box (radius ~3464)
    // instead of clamping at the old fixed 1000 (which would clip most of it).
    expect(cam!.far).toBeGreaterThan(2000);
    // near stayed positive and bounded away from zero (no z-fight, no clip).
    expect(cam!.near).toBeGreaterThan(0);
    expect(cam!.far / cam!.near).toBeLessThanOrEqual(50_001);
    expect(cam!.lookThrough).toBe(false);
  });
});
