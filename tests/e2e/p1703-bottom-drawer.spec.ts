// #1703 — the bottom drawer splits the window: with any tab open it takes the full width at the
// bottom and the viewport and both side panels end above it. Nothing of the picture is under it.
// #1704 — "full width" is now the width left of the chat column: the chat runs from the menu bar
// to the window's bottom and the drawer ends at its left edge (updated on purpose).
import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

// #1952 — works inside the outliner / inspector, so it runs with both panels open (see _fixtures).
test.use({ sidePanels: 'open' });

type Box = { x: number; y: number; width: number; height: number };

async function box(page: Page, testId: string): Promise<Box> {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box (not rendered)`);
  return b;
}

test('with any drawer tab open, the drawer spans the window and nothing of the viewport is under it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'true');

  const tabs = page.getByTestId('timeline-tab-strip').getByRole('tab');
  const count = await tabs.count();
  expect(count).toBeGreaterThan(0);
  const window = page.viewportSize()!;

  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    const name = (await tab.textContent())?.trim();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');

    const drawer = await box(page, 'timeline-drawer');
    const chat = await box(page, 'agentdock-slot');
    // Full width up to the chat column: the drawer is not a centred island.
    expect(drawer.x, `${name}: drawer left`).toBeLessThanOrEqual(0.5);
    expect(drawer.width, `${name}: drawer width`).toBeGreaterThanOrEqual(
      window.width - chat.width - 1,
    );
    expect(drawer.x + drawer.width, `${name}: drawer ends at the chat`).toBeLessThanOrEqual(
      chat.x + 0.5,
    );
    // The 3D picture ends where the drawer begins.
    for (const id of ['view3d-slot', 'tree-slot', 'inspector-slot']) {
      const b = await box(page, id);
      expect(b.y + b.height, `${name}: ${id} bottom vs drawer top`).toBeLessThanOrEqual(
        drawer.y + 0.5,
      );
    }
  }
});

test('closing the drawer gives the viewport its full height back', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  const closed = await box(page, 'view3d-slot');
  await page.getByTestId('timeline-drawer-toggle').click();
  const opened = await box(page, 'view3d-slot');
  expect(opened.height).toBeLessThan(closed.height);
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'false');
  const again = await box(page, 'view3d-slot');
  expect(again.height).toBe(closed.height);
});
