// Spline redesign Wave C — right inspector full-height + agent bottom dock.
//
// Falsifiable acceptance for the layout move: the agent left the cramped 280px
// right column for a full-width always-on bottom dock, and the inspector now
// owns the full-height right column. The old RightDrawer is gone. §196 holds:
// the same AgentChat drives from its new home.
//
// REF: docs/UI-SPEC.md §5.5, §5.8; THESIS §15, §196.

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

test('WC#1 agent is a full-width bottom dock, not a narrow right column', async ({ page }) => {
  // The old right-column drawer no longer exists.
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  const dock = page.getByTestId('agent-dock');
  await expect(dock).toBeVisible();
  const dockBox = await dock.boundingBox();
  const layoutBox = await page.getByTestId('layout').boundingBox();
  if (!dockBox || !layoutBox) throw new Error('missing boxes');
  // Full-width: spans far more than the old 280px column (≥60% of the layout).
  expect(dockBox.width).toBeGreaterThan(layoutBox.width * 0.6);
  // Bottom: the dock sits in the lower portion of the layout.
  expect(dockBox.y).toBeGreaterThan(layoutBox.y + layoutBox.height * 0.5);
});

test('WC#2 inspector owns the full-height right column', async ({ page }) => {
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toBeVisible();
  const box = await inspector.boundingBox();
  const layoutBox = await page.getByTestId('layout').boundingBox();
  if (!box || !layoutBox) throw new Error('missing boxes');
  // Right column: inspector's right edge is near the layout's right edge.
  expect(box.x + box.width).toBeGreaterThan(layoutBox.x + layoutBox.width - 8);
  // Full-height: it's much taller than the old side-by-side inspector|drawer
  // split — at least half the layout height (it now spans the whole content row
  // instead of sharing it with the agent column).
  expect(box.height).toBeGreaterThan(layoutBox.height * 0.45);
});

test('WC#3 present mode hides the agent dock', async ({ page }) => {
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('agent-dock')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('layout')).not.toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('agent-dock')).toBeVisible();
});

test('WC#4 §196 — the same AgentChat drives from the dock', async ({ page }) => {
  const dock = page.getByTestId('agent-dock');
  await expect(dock.getByTestId('agent-chat')).toBeVisible();
  await expect(dock.getByTestId('agent-input')).toBeVisible();
});
