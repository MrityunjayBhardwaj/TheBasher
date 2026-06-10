// Spline polish — the outliner (left) and inspector (right) panels overflow-
// scroll WITHOUT a visible scrollbar (the `.no-scrollbar` utility).
//
// Falsifiable against the real DOM via the COMPUTED `scrollbar-width`: the
// `.no-scrollbar` rule resolves it to `none`; removing the class from either
// panel makes it resolve back to `auto` → these assertions fail. (A gutter-
// width check does NOT bite here — headless Chromium on macOS uses overlay
// scrollbars that reserve no gutter whether or not the bar is hidden, so the
// computed property is the platform-independent signal.) Scroll is still
// proven live (clamp short → scrollHeight overflows → scrollTop moves).

import { expect, test } from './_fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('basher.chrome.v1');
      localStorage.removeItem('basher.leftSidebar.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('scene-tree')).toBeVisible();
  await expect(page.getByTestId('inspector')).toBeVisible();
});

for (const id of ['scene-tree', 'inspector']) {
  test(`${id} overflow-scrolls with no visible scrollbar gutter`, async ({ page }) => {
    const result = await page.evaluate((sel) => {
      const el = document.querySelector(`[data-testid="${sel}"]`) as HTMLElement | null;
      if (!el) throw new Error(`missing ${sel}`);
      const scrollbarWidth = getComputedStyle(el).scrollbarWidth;
      const overflowY = getComputedStyle(el).overflowY;
      // Clamp short so the content must overflow, then prove it scrolls.
      el.style.height = '60px';
      el.style.maxHeight = '60px';
      const scrollable = el.scrollHeight > el.clientHeight;
      el.scrollTop = 9999;
      return { scrollbarWidth, overflowY, scrollable, scrolled: el.scrollTop };
    }, id);
    // Still a scroll container, and it actually scrolls.
    expect(result.overflowY).toBe('auto');
    expect(result.scrollable).toBe(true);
    expect(result.scrolled).toBeGreaterThan(0);
    // The bar is hidden: removing `.no-scrollbar` flips this to 'auto' → fails.
    expect(result.scrollbarWidth).toBe('none');
  });
}
