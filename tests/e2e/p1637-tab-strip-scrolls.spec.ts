// #1637 — with enough projects open, the tab strip scrolls; the editor stays the window's
// width. Before the fix the layout grid's `1fr` column (`minmax(auto, 1fr)`) and the tab
// scroller's flex `min-width: auto` grew to the tabs' width: 38 tabs made a 1,512 px window's
// document 4,334 px wide and the viewport's centre went off-screen.
//
// The overflow assertion is the fixture's own check: if the tabs did not outgrow the strip,
// the width assertions below would pass vacuously.

import { expect, test } from './_fixtures';

const TABS = 14;

// Up to 14 project creations at up to ~5 s each under load.
test.setTimeout(120_000);

test('many open projects scroll inside the tab strip; the editor keeps the window width', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
  page.on('dialog', (d) => void d.accept(`Tab ${Date.now() % 100000}`));

  const tabs = page.locator('[data-testid^="project-tab-select-"]');
  // The list of saved projects loads after the layout does, so the count is read after
  // each click settles rather than from a starting number.
  await expect(tabs.first()).toBeVisible();
  while ((await tabs.count()) < TABS) {
    const before = await tabs.count();
    await page.getByTestId('project-tab-new').click();
    // A new project is written to storage before its tab appears: 0.8–5.1 s each on a loaded
    // machine (measured 2026-10-16), so the default 5 s poll failed at whichever click was slowest.
    await expect.poll(() => tabs.count(), { timeout: 20_000 }).toBeGreaterThan(before);
  }

  const m = await page.evaluate(() => {
    const strip = document
      .querySelector('[data-testid^="project-tab-select-"]')!
      .closest('.overflow-x-auto') as HTMLElement;
    return {
      window: window.innerWidth,
      document: document.documentElement.scrollWidth,
      canvas: Math.round(document.querySelector('canvas')!.getBoundingClientRect().width),
      stripVisible: strip.clientWidth,
      stripContent: strip.scrollWidth,
    };
  });
  // The fixture reached the case: the tabs together are wider than the window.
  expect(m.stripContent).toBeGreaterThan(m.window);
  // ...and that width stays inside the strip, which scrolls.
  expect(m.document).toBeLessThanOrEqual(m.window);
  expect(m.canvas).toBeLessThanOrEqual(m.window);
  expect(m.stripContent).toBeGreaterThan(m.stripVisible);
});
