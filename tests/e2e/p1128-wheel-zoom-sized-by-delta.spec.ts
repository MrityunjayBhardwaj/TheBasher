// #1128 — viewport wheel zoom is sized by how far the wheel moved.
//
// Measured on the parent with these same events: every wheel event dollied the camera by exactly
// ×0.95 of its distance to the orbit target, whether it was a mouse notch (deltaY 100) or a
// trackpad-sized event (deltaY 4). A trackpad sends dozens of events a second, so a gentle scroll
// became a train of full 5% jumps, and near the origin each one grew the box on screen by up to
// half its size.
//
// Observed through the live camera: the distance to the orbit target before and after each event.

import { test, expect, type Page } from './_fixtures';

type W = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const distance = (page: Page) =>
  page.evaluate(() => {
    const r = (window as W).__basher_three.getState();
    return r.camera.position.distanceTo(r.controlsTarget) as number;
  });

const orthoZoom = (page: Page) =>
  page.evaluate(() => (window as W).__basher_three.getState().camera.zoom as number);

/** Settle: the damped controls stop moving the camera. */
async function settled(page: Page, read: (p: Page) => Promise<number>): Promise<number> {
  let prev = await read(page);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(50);
    const now = await read(page);
    if (Math.abs(now - prev) < 1e-9) return now;
    prev = now;
  }
  return prev;
}

/** A wheel event dispatched on the viewport canvas, where a real one lands. */
async function wheel(page: Page, deltaY: number, ctrlKey = false): Promise<void> {
  await page.evaluate(
    ({ deltaY, ctrlKey }) => {
      const canvas = document.querySelector('main[aria-label^="3D viewport"] canvas')!;
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY, deltaMode: 0, ctrlKey, bubbles: true, cancelable: true }),
      );
    },
    { deltaY, ctrlKey },
  );
}

async function ratioOf(page: Page, deltaY: number, ctrlKey = false): Promise<number> {
  const before = await settled(page, distance);
  await wheel(page, deltaY, ctrlKey);
  const after = await settled(page, distance);
  return after / before;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => (window as W).__basher_view_fit?.wants === false, null, {
    timeout: 15_000,
  });
});

test('a mouse notch keeps its 5% step; a trackpad event and a pinch are sized by their delta', async ({
  page,
}) => {
  // Mouse notch: unchanged.
  expect(await ratioOf(page, -100)).toBeCloseTo(0.95, 6);
  expect(await ratioOf(page, 100)).toBeCloseTo(1 / 0.95, 6);

  // Trackpad-sized event: a twenty-fifth of a notch, not a whole one.
  expect(await ratioOf(page, -4)).toBeCloseTo(Math.pow(0.95, 0.04), 6);

  // Pinch (a wheel event with ctrlKey and no Control key down): amplified ×10.
  expect(await ratioOf(page, -2, true)).toBeCloseTo(Math.pow(0.95, 0.2), 6);

  // The page itself is not scrolled or zoomed by any of it.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('wheel zoom still reaches the camera after the projection is toggled and back', async ({
  page,
}) => {
  // Toggling the projection swaps the default camera, and drei builds new controls for it.
  await page.getByTestId('projection-toggle-orthographic').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as W).__basher_three.getState().camera.isOrthographicCamera),
    )
    .toBe(true);
  const zoomBefore = await settled(page, orthoZoom);
  await wheel(page, -100);
  await expect.poll(() => orthoZoom(page)).toBeGreaterThan(zoomBefore);

  await page.getByTestId('projection-toggle-perspective').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as W).__basher_three.getState().camera.isPerspectiveCamera),
    )
    .toBe(true);
  expect(await ratioOf(page, -100)).toBeCloseTo(0.95, 6);
});
