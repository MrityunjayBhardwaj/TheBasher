// #167 — the editor view re-frames on in-session project switch.
//
// #165 decoupled the editor orbit view from the DAG scene camera and booted it
// once via a guard. That guard was scoped to the component lifetime (the Canvas
// mounts once), so switching projects WITHOUT a reload stranded the view at the
// previous project's pose — it ignored the new project's active camera and its
// saved view. The fix keys the boot guard to the project id, so each project
// (including one switched to in-session) re-frames on first free-mode frame.
//
// This test observes the REAL R3F canvas (Lokayata): orbit project A away from
// its boot pose (which saves A's view), then switch to a fresh duplicate (a new
// id with NO saved view) and assert the view snaps back to the active camera's
// production framing. Falsifiable: revert to the lifetime-scoped boolean guard
// and the view stays at A's orbited pose → the final assertion fails.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_view_camera?: () => {
    position: [number, number, number];
    fov: number;
    near: number;
    far: number;
    lookThrough: boolean;
  } | null;
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_view_camera),
  );
  await page.waitForTimeout(300);
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

test.describe('#167 project-switch reframe', () => {
  test('switching projects re-frames the editor view to the new project', async ({ page }) => {
    await waitReady(page);

    // Capture the boot framing (#186 bounds-fit), then orbit well away from it.
    // OrbitControls onEnd persists this pose to basher.editorView.default.
    const boot = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_view_camera!().position,
    );
    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 250, cy + 80, { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const orbited = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_view_camera!().position,
    );
    // Precondition: we actually moved the view off the boot framing.
    expect(dist(orbited, boot)).toBeGreaterThan(0.5);

    // Duplicate the current project → a fresh id with NO saved editor view,
    // switched to in-session (no reload). This is the exact path that #167
    // regressed. (Duplicate needs no prompt dialog, unlike "+ new".)
    const before = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
    await page.getByTestId('menu-file').click();
    await page.getByTestId('menu-file-duplicate').click();
    // Wait for the switch to land: lastProjectId flips to the new project id.
    await page.waitForFunction(
      (prev) => localStorage.getItem('basher.lastProjectId') !== prev,
      before,
    );
    await page.waitForTimeout(400);

    const afterSwitch = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_view_camera!().position,
    );
    // The new project has no saved view, so the editor RE-FRAMES to its bounding
    // sphere (#186 full bounds-fit) along the canonical [3,2,3] angle — moving
    // OFF the orbited pose. Revert the reframe → the guard stays latched → the
    // view sits at A's orbited pose → both assertions below fail.
    expect(dist(afterSwitch, orbited)).toBeGreaterThan(0.3);
    const d = Math.hypot(afterSwitch[0], afterSwitch[1], afterSwitch[2]);
    const len = Math.hypot(3, 2, 3);
    expect(afterSwitch[0] / d).toBeCloseTo(3 / len, 1);
    expect(afterSwitch[1] / d).toBeCloseTo(2 / len, 1);
    expect(afterSwitch[2] / d).toBeCloseTo(3 / len, 1);
  });
});
