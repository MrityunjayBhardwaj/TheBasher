// #1857 — every Add-menu submenu stays inside the window, so its last item can be clicked where it
// is drawn. On a 1280×720 window Shift+A ▸ Compute (20 items, 562px) used to open at y=560 and run
// to y=1122, and Lag, its last item, could be neither clicked nor scrolled to. Now a submenu moves
// up until its bottom fits, and one taller than the window is capped to it and scrolls.
//
// Each check asks the page which element is drawn at the item's centre, not only where its box is:
// a box can sit inside the window while a clipping parent hides it.
//
// REF: src/app/menu/useFlyoutSide.ts (the vertical half); src/app/AddMenu.tsx (`AddMenuGroup`).

import type { Locator, Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
}

async function openAddMenu(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag));
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await expect(page.getByTestId('add-menu-compute')).toBeVisible();
}

/** Whether `item` is the element drawn at its own centre, inside the window. */
async function drawnWhereItIs(page: Page, item: Locator): Promise<boolean> {
  const b = await item.boundingBox();
  if (!b) return false;
  const { width, height } = page.viewportSize()!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  if (cx < 0 || cy < 0 || cx > width || cy > height) return false;
  return item.evaluate((el, [x, y]) => el.contains(document.elementFromPoint(x, y)), [cx, cy]);
}

test('at 1280×720 the last item of every Add submenu is drawn inside the window, and Lag adds a Lag', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openAddMenu(page, 1280, 720);
  const groups = page.locator('[data-testid^="add-menu-"][aria-haspopup="menu"]');
  const labels = await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
  expect(labels).toContain('add-menu-compute');
  for (const testId of labels) {
    await page.getByTestId(testId).hover();
    const last = page.getByTestId(`${testId}-panel`).locator('[role="menuitem"]').last();
    await expect(last).toBeVisible();
    expect(await drawnWhereItIs(page, last), `${testId}'s last item`).toBe(true);
  }

  // The longest group's last item, clicked where it is drawn.
  await page.getByTestId('add-menu-compute').hover();
  const before = await page.evaluate(() =>
    Object.keys((window as unknown as W).__basher_dag.getState().state.nodes),
  );
  await page.getByTestId('add-menu-item-Lag').click();
  await expect
    .poll(() =>
      page.evaluate(
        (had) =>
          Object.entries((window as unknown as W).__basher_dag.getState().state.nodes).filter(
            ([id, n]) => !had.includes(id) && n.type.startsWith('template.'),
          ).length,
        before,
      ),
    )
    .toBe(1);
});

test('a submenu taller than the window is capped to it and scrolls to its last item', async ({
  page,
}) => {
  await openAddMenu(page, 1280, 400);
  await page.getByTestId('add-menu-compute').hover();
  const panel = page.getByTestId('add-menu-compute-panel');
  const box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(400);
  const lag = page.getByTestId('add-menu-item-Lag');
  expect(await drawnWhereItIs(page, lag)).toBe(false); // below the fold until scrolled
  await panel.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  expect(await drawnWhereItIs(page, lag)).toBe(true);
});
