// #1703 — the bottom drawer has a resize handle on its top edge, and each tab keeps its own
// height: dragging the Dopesheet taller leaves the Curves tab at its own height, coming back to the
// Dopesheet finds it where it was left, and a reload keeps both. The drag is clamped so the
// viewport above always keeps a usable height. Removing the handle, the per-tab memory, the
// persistence or the clamp each reds one assertion here.
import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

async function drawerHeight(page: Page): Promise<number> {
  const b = await page.getByTestId('timeline-drawer').boundingBox();
  if (!b) throw new Error('timeline-drawer has no box');
  return b.height;
}

/** Drag the handle by `dy` pixels (negative = up = taller). */
async function dragHandle(page: Page, dy: number): Promise<void> {
  const handle = page.getByTestId('timeline-drawer-resize-handle');
  const b = await handle.boundingBox();
  if (!b) throw new Error('resize handle has no box');
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 4 });
  await page.mouse.move(x, y + dy, { steps: 4 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'true');
});

test('each drawer tab remembers its own height, across a tab switch and a reload', async ({
  page,
}) => {
  await page.getByTestId('timeline-tab-dopesheet').click();
  await expect(page.getByTestId('timeline-drawer-resize-handle')).toBeVisible();
  const dopeBefore = await drawerHeight(page);
  await page.getByTestId('timeline-tab-curve').click();
  const curveBefore = await drawerHeight(page);

  await page.getByTestId('timeline-tab-dopesheet').click();
  await dragHandle(page, -100);
  const dopeAfter = await drawerHeight(page);
  expect(dopeAfter - dopeBefore).toBeGreaterThan(90);
  expect(dopeAfter - dopeBefore).toBeLessThan(110);

  // Another tab keeps its own height.
  await page.getByTestId('timeline-tab-curve').click();
  expect(await drawerHeight(page)).toBeCloseTo(curveBefore, 0);
  // Back on the Dopesheet: the height it was left at.
  await page.getByTestId('timeline-tab-dopesheet').click();
  expect(await drawerHeight(page)).toBeCloseTo(dopeAfter, 0);

  // A reload keeps both.
  await page.reload();
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  if ((await page.getByTestId('timeline-drawer').getAttribute('data-open')) !== 'true') {
    await page.getByTestId('timeline-drawer-toggle').click();
  }
  await page.getByTestId('timeline-tab-dopesheet').click();
  expect(await drawerHeight(page)).toBeCloseTo(dopeAfter, 0);
  await page.getByTestId('timeline-tab-curve').click();
  expect(await drawerHeight(page)).toBeCloseTo(curveBefore, 0);
});

test('the drag is clamped: the viewport keeps a usable height and the drawer a usable floor', async ({
  page,
}) => {
  await page.getByTestId('timeline-tab-dopesheet').click();
  const window = page.viewportSize()!;
  // Far up: the drawer stops before it eats the viewport.
  await dragHandle(page, -window.height);
  const view = await page.getByTestId('view3d-slot').boundingBox();
  expect(view!.height).toBeGreaterThanOrEqual(200);
  const drawer = await page.getByTestId('timeline-drawer').boundingBox();
  expect(view!.y + view!.height).toBeLessThanOrEqual(drawer!.y + 0.5);

  // Far down: the drawer keeps its tab strip and some body.
  await dragHandle(page, window.height);
  expect(await drawerHeight(page)).toBeGreaterThanOrEqual(120);
  await expect(page.getByTestId('timeline-tab-strip')).toBeVisible();
});
