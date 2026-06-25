// Regression — the top MenuBar dropdowns must open ABOVE the Video editor surface.
//
// The Video space mounts the compositor as an absolute overlay at zIndex:45
// (Layout.tsx, covering the 3D-only floating chrome). The MenuBar dropdown opens
// downward from the menu row INTO that region; at z-40 it rendered BEHIND the
// compositor — present in the DOM (so isVisible() passed — a false green) but
// occluded, with clicks falling through to the canvas → every top menu was dead in
// VIDEO mode. The dropdown is now z-50 (the global-chrome tier, above the 45 slot).
//
// Falsifiable two ways: (1) hit-test — document.elementFromPoint at a menu item's
// centre must resolve INTO the dropdown, not the compositor; (2) functional — a menu
// item click in video mode actually fires its action. Drop the z-index back to 40 and
// both fail.

import { expect, test } from './_fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
});

test('the File dropdown opens above the compositor in video mode (not occluded)', async ({
  page,
}) => {
  await page.getByTestId('menu-file-button').click();
  const item = page.getByTestId('menu-file-import-media');
  await expect(item).toBeVisible();

  // Hit-test: the top element at the item's centre must be the item itself, NOT the
  // video surface behind it (the occlusion isVisible() can't catch).
  const topIsItem = await item.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el.contains(top);
  });
  expect(topIsItem).toBe(true);
});

test('a File menu item is clickable (fires its action) in video mode', async ({ page }) => {
  await page.getByTestId('menu-file-button').click();
  // Import Media opens a file chooser — proof the click reached the item, through to
  // its handler, rather than hitting the compositor canvas underneath.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('menu-file-import-media').click(),
  ]);
  expect(chooser).toBeTruthy();
});
