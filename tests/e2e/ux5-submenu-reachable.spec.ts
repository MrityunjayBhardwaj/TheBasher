// MenuBar submenus must be REACHABLE by real pointer interaction. Two bugs made
// every View/File/Select submenu unreachable:
//   1. clicking the submenu trigger toggled it SHUT (hover opened it, the click
//      closed it) — "click Clipping → nothing happens";
//   2. moving the pointer from the trigger toward the flyout crossed a seam /
//      drifted past a sibling, firing the container's mouseleave → the flyout
//      unmounted before the pointer arrived.
// The fix: the trigger click OPENS (never toggles), and a close-delay survives
// the seam/drift until the pointer re-enters the flyout. This pins both with
// REAL mouse movement (not Playwright's teleporting .hover()).

import { test, expect } from './_fixtures';

async function openViewMenu(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_dag?: unknown }).__basher_dag),
  );
  await page.waitForTimeout(400);
  const vb = (await page.getByTestId('menu-view-button').boundingBox())!;
  await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2);
  await expect(page.getByTestId('menu-view-panel')).toBeVisible();
}

test.describe('MenuBar submenu reachability', () => {
  test('clicking a submenu trigger keeps the flyout OPEN (does not toggle shut)', async ({
    page,
  }) => {
    await openViewMenu(page);
    const tb = (await page.getByTestId('menu-view-clipping').boundingBox())!;
    // Hover opens it, then a real click on the trigger — must stay open.
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await expect(page.getByTestId('menu-view-clip-auto')).toBeVisible();
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(120);
    // Reverting the fix (onClick toggles) → the click closes it → this fails.
    await expect(page.getByTestId('menu-view-clip-auto')).toBeVisible();
  });

  test('reaching the flyout by moving the pointer right then selecting an item works', async ({
    page,
  }) => {
    await openViewMenu(page);
    const tb = (await page.getByTestId('menu-view-clipping').boundingBox())!;
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await expect(page.getByTestId('menu-view-clip-auto')).toBeVisible();
    // Travel into the flyout (crosses the trigger→flyout seam). Reverting the
    // close-delay → the flyout unmounts mid-travel → the item is gone.
    await page.mouse.move(tb.x + tb.width + 40, tb.y + tb.height / 2, { steps: 10 });
    await page.waitForTimeout(150);
    const auto = page.getByTestId('menu-view-clip-auto');
    await expect(auto).toBeVisible();
    // And the item is actually selectable → the whole menu closes on select.
    await auto.click();
    await expect(page.getByTestId('menu-view-panel')).toHaveCount(0);
  });
});
