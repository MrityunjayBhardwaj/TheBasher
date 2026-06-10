// Spline redesign Wave D — viewport toolbar restyle to the Spline floating pill.
//
// Falsifiable acceptance for the restyle: the consolidated toolbar is a SINGLE
// rounded pill (the W1 consolidation invariant still holds after the cosmetic
// pass) and its chips/buttons dropped the dense UPPERCASE tracking-wide
// dev-tool treatment for Spline's clean normal-case labels. The §196 create
// paths (Add / Assets) survive the restyle.
//
// REF: docs/UI-SPEC.md §5.3, §5.7; docs/SPLINE-UI-REFERENCE.md region ②;
// THESIS §196.

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
  await expect(page.getByTestId('layout')).toBeVisible();
});

test('WD#1 the viewport toolbar is exactly one floating pill', async ({ page }) => {
  // The W1 consolidation invariant — restyling must not have re-introduced a
  // second toolbar surface. Falsified by mounting a duplicate pill (count===2).
  await expect(page.getByTestId('floating-viewport-toolbar')).toHaveCount(1);
});

test('WD#2 toolbar chips dropped the UPPERCASE dev-tool treatment', async ({ page }) => {
  // Spline-exact: clean normal-case labels, not the dense uppercase
  // tracking-wide chips. Falsified by re-adding `uppercase` to the shading
  // Chip / Add BarButton — text-transform would read 'uppercase' again.
  const shading = page.getByTestId('floating-toolbar-shading-studio');
  await expect(shading).toBeVisible();
  const shadingTransform = await shading.evaluate((el) => getComputedStyle(el).textTransform);
  expect(shadingTransform).not.toBe('uppercase');

  const add = page.getByTestId('top-toolbar-add');
  await expect(add).toBeVisible();
  const addTransform = await add.evaluate((el) => getComputedStyle(el).textTransform);
  expect(addTransform).not.toBe('uppercase');
});

test('WD#3 §196 — Add and Assets create paths survive the restyle', async ({ page }) => {
  const toolbar = page.getByTestId('floating-viewport-toolbar');
  await expect(toolbar.getByTestId('top-toolbar-add')).toBeVisible();
  await expect(toolbar.getByTestId('top-toolbar-assets')).toBeVisible();
});

test('WD#4 the pill stays one row and scrolls horizontally (no wrap, no bar)', async ({ page }) => {
  // Narrow the window so the toolbar can't fit — it must overflow-scroll on a
  // single line, not wrap to a taller stack.
  await page.setViewportSize({ width: 900, height: 760 });
  const toolbar = page.getByTestId('floating-viewport-toolbar');
  await expect(toolbar).toBeVisible();
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="floating-viewport-toolbar"]') as HTMLElement;
    const cs = getComputedStyle(el);
    el.scrollLeft = 9999;
    return {
      flexWrap: cs.flexWrap,
      overflowX: cs.overflowX,
      scrollbarWidth: cs.scrollbarWidth,
      clientH: el.clientHeight,
      overflowsX: el.scrollWidth > el.clientWidth,
      scrolledLeft: el.scrollLeft,
    };
  });
  // Single row: re-adding `flex-wrap` makes it stack → clientHeight balloons
  // past one button row → this fails.
  expect(r.flexWrap).toBe('nowrap');
  expect(r.clientH).toBeLessThan(50);
  // Overflows on X and actually scrolls horizontally (items don't compress).
  expect(r.overflowX).toBe('auto');
  expect(r.overflowsX).toBe(true);
  expect(r.scrolledLeft).toBeGreaterThan(0);
  // No visible scrollbar — `.no-scrollbar` resolves scrollbar-width to none.
  expect(r.scrollbarWidth).toBe('none');
});

test('WD#5 the toolbar sits at the TOP of the viewport, not the bottom', async ({ page }) => {
  const toolbar = page.getByTestId('floating-viewport-toolbar');
  const main = page.getByTestId('viewport-slot');
  const tb = await toolbar.boundingBox();
  const vp = await main.boundingBox();
  if (!tb || !vp) throw new Error('missing boxes');
  // Top-anchored: the pill sits in the upper portion of the viewport.
  // Reverting to `bottom-4` drops it into the lower half → this fails.
  expect(tb.y).toBeLessThan(vp.y + vp.height * 0.4);
});
