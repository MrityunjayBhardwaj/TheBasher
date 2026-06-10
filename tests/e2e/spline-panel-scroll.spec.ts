// Spline polish — the outliner (left) and inspector (right) panels overflow-
// scroll WITHIN their own bounds (no page blow-out) and WITHOUT a visible
// scrollbar.
//
// Two real-DOM, falsifiable properties per panel, both exercised by injecting a
// tall (2000px) child so the panel genuinely overflows (the example scene is
// too short to overflow on its own):
//
//   1. BOUNDED + scrolls. The panel's grid/flex wrapper carries min-height:0, so
//      the panel stays clamped to its track and the overflow scrolls internally
//      (clientHeight << scrollHeight, scrollTop moves) instead of the panel
//      growing to its content and dragging the whole layout past the viewport.
//      Falsifier: drop minHeight:0 from the inspector grid cell / the left
//      sidebar's min-h-0 → the panel balloons, document.body.scrollHeight blows
//      past the viewport, and scrollTop can't move → fails.
//   2. NO visible scrollbar. Computed `scrollbar-width` is `none` (the
//      `.no-scrollbar` utility). A gutter-width check is INERT here — headless
//      Chromium on macOS uses overlay scrollbars that reserve no gutter either
//      way — so the computed property is the platform-independent signal.
//      Falsifier: remove `.no-scrollbar` → resolves to `auto` → fails.

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
  test(`${id} stays bounded and scrolls internally on overflow, no scrollbar`, async ({ page }) => {
    const r = await page.evaluate((sel) => {
      const el = document.querySelector(`[data-testid="${sel}"]`) as HTMLElement | null;
      if (!el) throw new Error(`missing ${sel}`);
      const scrollbarWidth = getComputedStyle(el).scrollbarWidth;
      const overflowY = getComputedStyle(el).overflowY;
      // Inject genuinely tall content so the panel must overflow.
      const tall = document.createElement('div');
      tall.style.height = '2000px';
      tall.style.flex = '0 0 auto';
      el.appendChild(tall);
      el.scrollTop = 9999;
      return {
        scrollbarWidth,
        overflowY,
        clientH: el.clientHeight,
        scrollH: el.scrollHeight,
        scrolledTo: el.scrollTop,
        bodyScrollH: document.body.scrollHeight,
        viewportH: window.innerHeight,
      };
    }, id);
    // 1. Bounded: the panel is far shorter than its content (clamped to track).
    expect(r.overflowY).toBe('auto');
    expect(r.clientH).toBeLessThan(r.scrollH - 500);
    // ...and it actually scrolled.
    expect(r.scrolledTo).toBeGreaterThan(0);
    // ...and the page did NOT blow out past the viewport.
    expect(r.bodyScrollH).toBeLessThanOrEqual(r.viewportH + 1);
    // 2. No visible scrollbar.
    expect(r.scrollbarWidth).toBe('none');
  });
}
