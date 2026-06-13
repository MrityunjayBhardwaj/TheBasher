// UX backlog #5 — submenu flyouts stay within the viewport (edge-aware flip).
//
// THE BUG THIS KILLS
// ==================
// Both MenuBar's Submenu and AddMenu's group submenus hardcoded `left-full`
// (always open to the RIGHT of the trigger). A right-side menu's submenu
// (View ▸ Shading at a narrow width) and an Add menu the root-clamp pushed
// against the right edge (Add ▸ Light near the right edge) ran straight off
// the viewport — observed off-screen by 56px and 191px respectively. This is
// the same class as H91 (a placement constant that ignores available space).
//
// THE FIX (shared useFlyoutSide): measure the trigger container on open and
// place the panel by preference — open right, else flip left, else clamp to the
// viewport edge (the View-bar case sits too near x=0 for a left-flip to fit).
//
// Falsifiable: revert to a hardcoded `left-full` and the right-edge asserts
// below fail (the submenu's right edge crosses innerWidth).
//
// REF: src/app/menu/useFlyoutSide.ts; src/app/MenuBar.tsx (Submenu);
//      src/app/AddMenu.tsx (AddMenuGroup); UX-BACKLOG #5; H91.

import { expect, test } from './_fixtures';

async function box(loc: import('@playwright/test').Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('no bounding box');
  return b;
}

test('MenuBar: a right-side menu submenu stays within the viewport at a narrow width', async ({
  page,
}) => {
  // Narrow viewport so the (left-aligned) menu bar's right-most menu sits close
  // to the right edge — opening its submenu rightward would overflow.
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto('/');
  await expect(page.getByTestId('menubar')).toBeVisible();

  await page.getByTestId('menu-view-button').click();
  await expect(page.getByTestId('menu-view-panel')).toBeVisible();
  await page.getByTestId('menu-view-shading').hover();

  // The submenu is the role=menu nested INSIDE the Shading container.
  const submenu = page
    .getByTestId('menu-view-shading')
    .locator('xpath=..')
    .locator('[role="menu"]');
  await expect(submenu).toBeVisible();
  const m = await box(submenu);

  // Stays fully on-screen on the right (flipped to the left of its trigger).
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(640);
});

test('AddMenu: a group submenu near the right edge stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();

  // Open the Add menu near the right edge (the same path Layout's viewport
  // onContextMenu uses: openAt(clientX, clientY)). The root clamps its own left
  // to the right edge; the submenu must then flip left rather than overflow.
  await page.evaluate(() => {
    const main = document.querySelector('[data-testid="viewport-slot"]') as HTMLElement;
    main.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 1200,
        clientY: 400,
      }),
    );
  });
  await expect(page.getByTestId('add-menu')).toBeVisible();

  await page.getByTestId('add-menu-light').hover();
  const submenu = page.getByTestId('add-menu-light-panel');
  await expect(submenu).toBeVisible();
  const m = await box(submenu);

  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(1280);
});

test('AddMenu: a group submenu opens RIGHTWARD when there is room (no needless flip)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();

  // Open near the LEFT — plenty of room to the right, so it should NOT flip.
  await page.evaluate(() => {
    const main = document.querySelector('[data-testid="viewport-slot"]') as HTMLElement;
    main.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 300,
      }),
    );
  });
  await expect(page.getByTestId('add-menu')).toBeVisible();

  const root = await box(page.getByTestId('add-menu'));
  await page.getByTestId('add-menu-light').hover();
  const submenu = await box(page.getByTestId('add-menu-light-panel'));
  // Opens to the RIGHT of the root (left edge of submenu ≈ right edge of root).
  expect(submenu.x).toBeGreaterThanOrEqual(root.x + root.width - 2);
});
