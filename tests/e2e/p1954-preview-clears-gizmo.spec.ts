// p1954 (#1954) — the live shot preview never covers the orbit gizmo.
//
// With the inspector folded to its rail (the first-start layout since #1952) the preview's corner
// used to land on the gizmo and the Persp/Ortho pill. It now steps left of that corner, keeping its
// height (lifting it would reach the toolbar once the drawer shortens the viewport); with the
// inspector open it stays where it was, beside the inspector.
//
// The gizmo is drawn in the canvas (drei GizmoHelper, `margin={[80, 80]}` in Viewport.tsx), so its
// box is read as the circle drei draws: centre 80 px in from the viewport's bottom-right, ≈40 px
// radius. The pill is DOM (`projection-toggle`).
//
// REF: src/app/layoutIslands.ts (livePreviewBox, BOTTOM_RIGHT_WIDGETS).
import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

type Box = { x: number; y: number; width: number; height: number };

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function box(page: Page, id: string): Promise<Box> {
  const b = await page.getByTestId(id).first().boundingBox();
  if (!b) throw new Error(`no box for ${id}`);
  return b;
}

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('basher.chrome.v1'));
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('live-preview')).toBeVisible();
}

async function gizmoBox(page: Page): Promise<Box> {
  const v = await box(page, 'viewport');
  // drei GizmoHelper alignment bottom-right, margin [80, 80]: centre 80 px in from each edge.
  return { x: v.x + v.width - 120, y: v.y + v.height - 120, width: 80, height: 80 };
}

test('inspector folded (the first start): the preview sits clear of the gizmo and the pill', async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');
  const preview = await box(page, 'live-preview');
  expect(overlaps(preview, await gizmoBox(page)), 'preview over the gizmo').toBe(false);
  expect(overlaps(preview, await box(page, 'projection-toggle')), 'preview over the pill').toBe(
    false,
  );
});

test('inspector open: the preview stays beside it, above the playback bar', async ({ page }) => {
  await boot(page);
  await page.getByTestId('inspector-expand-toggle').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'false');
  const preview = await box(page, 'live-preview');
  const insp = await box(page, 'inspector-slot');
  const v = await box(page, 'viewport');
  expect(preview.x + preview.width).toBeLessThanOrEqual(insp.x);
  // PLAYBACK_BAND (60) above the viewport's bottom: unchanged by #1954.
  expect(Math.round(v.y + v.height - (preview.y + preview.height))).toBe(60);
  expect(overlaps(preview, await gizmoBox(page))).toBe(false);
});

test('inspector folded with the drawer open (a short viewport): clear of the gizmo and the toolbar', async ({
  page,
}) => {
  await boot(page);
  await openDrawerTab(page, 'nodes');
  const preview = await box(page, 'live-preview');
  expect(overlaps(preview, await gizmoBox(page)), 'preview over the gizmo').toBe(false);
  expect(
    overlaps(preview, await box(page, 'floating-viewport-toolbar')),
    'preview over the toolbar',
  ).toBe(false);
});
