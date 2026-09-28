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
// Clip End to 100 brings the ceiling down to 1 000 for a view that comes back inside it.
//
// Observed through the live camera: its distance to the orbit target after wheel events on the
// viewport canvas, where a real one lands.
//
// #1292 — a view framed PAST that ceiling stays where it was framed, as Blender's does: View All
// clamps only a minimum (view3d_navigate_view_all.cc:130-135) and the wheel only refuses to go
// further out (view3d_navigate_view_zoom.cc:406). Measured before: the p186 box's fit (~11 768)
// was pulled in to 10 000 by the orbit's clamp.
//
// REF: src/viewport/cameraFit.ts `dollyRangeForClip`, `zoomLimitsAt`;
//      src/viewport/EditorViewCamera.tsx (the one writer of the range); issues #1288, #1292.

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

  // Lower Clip End to 100: the ceiling follows the clip, not the scene. Lowering it does not move
  // the view (#1292, Blender's rule) — it only stops a zoom from carrying it back out.
  await page.evaluate(() =>
    (window as W).__basher_viewport.getState().setViewportClipOverride({ near: 0.01, far: 100 }),
  );
  expect(await wheel(page, 3), 'lowering the clip moved the view').toBeCloseTo(10_000, 3);
  // 50 notches in: 10 000 × 0.95^50 ≈ 769, inside the new ceiling; then out as far as it goes.
  expect(await wheel(page, -50)).toBeLessThan(1_000);
  expect(await wheel(page, 20), 'ten Clip Ends of 100').toBeCloseTo(1_000, 3);
});

test('a view the fit framed past ten Clip Ends stays there; the wheel cannot carry it further out', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await settleViewFit(page);
  // The p186 scene: the seed box grown to 4000 units (radius ≈ 3464), then a duplicate — a fresh
  // project with no saved view — so the boot fit frames it.
  await page.evaluate(() =>
    (window as W).__basher_dag.getState().dispatch({
      type: 'setParam',
      nodeId: 'n_box_data',
      paramPath: 'size',
      value: [4000, 4000, 4000],
    }),
  );
  const before = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-file-duplicate').click();
  await page.waitForFunction(
    (prev) => localStorage.getItem('basher.lastProjectId') !== prev,
    before,
  );
  // The new project's fit has begun once the view stands back from the grown box; then let it end.
  await page.waitForFunction(() => {
    const r = (window as W).__basher_three.getState();
    return r.camera.position.distanceTo(r.controlsTarget) > 1000;
  });
  await settleViewFit(page);

  // What the fit asked for: the sphere tangent to the tighter frustum side, with the 1.3 margin.
  const asked = await page.evaluate(() => {
    const c = (window as W).__basher_three.getState().camera;
    const half = (c.fov * Math.PI) / 360;
    const r = Math.hypot(2000, 2000, 2000);
    return (1.3 * r) / Math.min(Math.sin(half), Math.sin(Math.atan(Math.tan(half) * c.aspect)));
  });
  expect(asked, 'the scene no longer frames past the ceiling').toBeGreaterThan(10_000);
  const framed = await settled(page);
  expect(framed, 'the orbit pulled the framed view in to its ceiling').toBeCloseTo(asked, 0);

  // Out: refused, the view stays. In: allowed. Out again: only as far as it stood.
  expect(await wheel(page, 3)).toBeCloseTo(framed, 3);
  const nearer = await wheel(page, -2);
  expect(nearer).toBeLessThan(framed);
  expect(await wheel(page, 5)).toBeCloseTo(nearer, 3);
});
