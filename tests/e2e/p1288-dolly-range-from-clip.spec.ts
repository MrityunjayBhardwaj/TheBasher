// #1288 — the view dollies as far as its Clip End allows, whatever it booted on.
//
// Measured before the fix, with these same events: in a fresh project the view fitted the default
// 1 m cube and set the orbit's reach to (2.94 + 0.866) × 10 = 38.08. After importing
// `walk-blender-default.glb` — a figure ~160 units tall that walks ~587 — sixty wheel notches out
// stopped at 38.08. The director could not stand back far enough to see the walk.
//
// Blender's range is the view's, not the scene's: a zoom is clamped to [grid × 0.001, clip_end × 10]
// (`ED_view3d_dist_soft_range_get`, view3d_utils.cc:154-165, v5.1.1). So the assertions are about
// the clip: at the default Clip End (1000) the view reaches 10 000 and stops there, and lowering
// Clip End to 100 brings the ceiling down to 1 000.
//
// Observed through the live camera: its distance to the orbit target after wheel events on the
// viewport canvas, where a real one lands.
//
// REF: src/viewport/cameraFit.ts `dollyRangeForClip`; src/viewport/EditorViewCamera.tsx (the one
//      writer of the range); issue #1288.

import { test, expect, settleViewFit, type Page } from './_fixtures';

type W = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const distance = (page: Page) =>
  page.evaluate(() => {
    const r = (window as W).__basher_three.getState();
    return r.camera.position.distanceTo(r.controlsTarget) as number;
  });

/** Settle: the damped controls stop moving the camera. */
async function settled(page: Page): Promise<number> {
  let prev = await distance(page);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(50);
    const now = await distance(page);
    if (Math.abs(now - prev) < 1e-9) return now;
    prev = now;
  }
  return prev;
}

/** `notches` mouse-wheel notches on the viewport canvas; positive dollies out. */
async function wheel(page: Page, notches: number): Promise<number> {
  await page.evaluate((n) => {
    const canvas = document.querySelector('main[aria-label^="3D viewport"] canvas')!;
    for (let i = 0; i < Math.abs(n); i++) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: Math.sign(n) * 100,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, notches);
  return settled(page);
}

test('after importing a walking character the view dollies out to ten Clip Ends, and the clip sets that ceiling', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await settleViewFit(page);
  const boot = await distance(page);

  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await (await fetch('/fixtures/anim/walk-blender-default.glb')).arrayBuffer(),
    );
    await (window as W).__basher_ingestGltfFolder([{ relativePath: 'walk.glb', bytes }], 'walk');
  });
  await page.waitForFunction(() => ((window as W).__basher_armature?.bones ?? 0) > 70, null, {
    timeout: 60_000,
  });
  // The import does not re-frame the view: the camera still stands where the boot fit put it,
  // so what follows starts from the default cube's framing, as it did when this was measured.
  expect(await settled(page)).toBeCloseTo(boot, 6);

  // ~190 notches at ×1/0.95 each would carry 2.94 past 50 000; the ceiling has to stop it.
  const out = await wheel(page, 190);
  expect(out, 'the view stopped short of the walk it has to see').toBeGreaterThan(587);
  expect(out, 'the ceiling is ten default Clip Ends').toBeCloseTo(10_000, 3);

  // Lower Clip End to 100: the ceiling follows the clip, not the scene.
  await page.evaluate(() =>
    (window as W).__basher_viewport.getState().setViewportClipOverride({ near: 0.01, far: 100 }),
  );
  expect(await wheel(page, 10), 'ten Clip Ends of 100').toBeCloseTo(1_000, 3);
});
