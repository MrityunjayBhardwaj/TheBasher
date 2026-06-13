// UX backlog #5 — toolbar menus open cleanly BELOW the toolbar pill.
//
// THE BUG THIS KILLS
// ==================
// The consolidated toolbar pill lives at `top-4` (top of the viewport) since
// v0.6 #4 W1. The "+ Add" menu still anchored at the button's TOP edge
// (`openAt(r.left, r.top)`) — a leftover from when the pill lived at the
// BOTTOM and the menu "opened upward automatically". With the pill at the top,
// that anchor rendered the menu OVER the toolbar row, covering the +Add button
// (UX backlog #5). The Assets popover was inconsistent (`r.bottom + 4`).
//
// The fix anchors the Add menu to the toolbar element's bottom edge
// (`toolbarMenuAnchor`), left-aligned to the clicked button, so it opens
// downward, clear of the pill.
//
// (UX #6 later re-homed the asset Library into the left panel's Assets tab, so
// the toolbar "Assets" button no longer opens a popover — it selects that tab;
// its coverage lives in p6-w3-leftsidebar.spec.ts. This spec now guards the Add
// menu anchor only.)
//
// Falsifiable: revert the anchor to `r.top` and the menu's top crosses above
// the toolbar's bottom → the assert fails.
//
// REF: src/app/FloatingViewportToolbar.tsx (toolbarMenuAnchor); UX-BACKLOG #5.

import { expect, test } from './_fixtures';

async function box(loc: import('@playwright/test').Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('no bounding box');
  return b;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();
});

test('#5 the Add menu opens below the toolbar pill (no overlap), left-aligned to its button', async ({
  page,
}) => {
  const toolbar = await box(page.getByTestId('floating-viewport-toolbar'));
  const addBtn = await box(page.getByTestId('top-toolbar-add'));

  await page.getByTestId('top-toolbar-add').click();
  const menu = page.getByTestId('add-menu');
  await expect(menu).toBeVisible();
  const m = await box(menu);

  // Opens BELOW the toolbar pill — the menu's top is at/under the pill bottom.
  expect(m.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
  // Left-aligned to the Add button (clamp keeps it on-screen; here it fits).
  expect(Math.abs(m.x - addBtn.x)).toBeLessThan(2);
});
