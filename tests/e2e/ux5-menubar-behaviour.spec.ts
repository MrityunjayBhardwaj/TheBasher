// UX backlog #5 — MenuBar behaviour: hover-switch + keyboard navigation.
//
// THE GAPS THIS KILLS
// ===================
// The MenuBar was click-only: with File open, hovering Edit did NOTHING (a
// standard menubar hover-switches between open top-level menus). And it had no
// keyboard navigation — ArrowDown on an open menu button left focus on the
// button instead of entering the items. Observed both directly before the fix.
//
// THE FIX
// =======
// - hover-switch: each top-level button's onMouseEnter switches the open menu
//   IFF one is already open (so the first open still needs a click).
// - keyboard: a menubar-level keydown handler — ArrowLeft/Right move between
//   top-level menus, ArrowDown/Up/Home/End rove the open panel's items.
//
// Falsifiable: remove the onMouseEnter wiring → hover-switch assert fails;
// remove onMenubarKeyDown → the ArrowDown/ArrowRight asserts fail.
//
// REF: src/app/MenuBar.tsx (hoverSwitch, onMenubarKeyDown); UX-BACKLOG #5.

import { expect, test } from './_fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menubar')).toBeVisible();
});

test('hover-switch: with one menu open, hovering another opens it (and the first closes)', async ({
  page,
}) => {
  await page.getByTestId('menu-file-button').click();
  await expect(page.getByTestId('menu-file-panel')).toBeVisible();

  // Hover Edit — it should open, File should close (standard menubar).
  await page.getByTestId('menu-edit-button').hover();
  await expect(page.getByTestId('menu-edit-panel')).toBeVisible();
  await expect(page.getByTestId('menu-file-panel')).toHaveCount(0);
});

test('hover alone does NOT open a menu — the first open still requires a click', async ({
  page,
}) => {
  await page.getByTestId('menu-file-button').hover();
  // No menu was open, so hover must not open one.
  await expect(page.getByTestId('menu-file-panel')).toHaveCount(0);
});

test('keyboard: ArrowDown enters the (enabled) menu items; ArrowRight/Left switch top-level', async ({
  page,
}) => {
  // Select's items are all enabled on a fresh scene (Edit's Undo/Redo are not,
  // and disabled items are correctly skipped by the roving cursor).
  await page.getByTestId('menu-select-button').click();
  await expect(page.getByTestId('menu-select-panel')).toBeVisible();

  // ArrowDown moves focus from the button into the first item.
  await page.keyboard.press('ArrowDown');
  const firstItem = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  expect(firstItem).toBe('menu-select-all');

  // ArrowDown advances to the next item.
  await page.keyboard.press('ArrowDown');
  const secondItem = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  expect(secondItem).toBe('menu-select-none');

  // ArrowRight switches to the next top-level menu (View) and opens it.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('menu-view-panel')).toBeVisible();
  await expect(page.getByTestId('menu-select-panel')).toHaveCount(0);

  // ArrowLeft switches back to Select.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('menu-select-panel')).toBeVisible();
});
