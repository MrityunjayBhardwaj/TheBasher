// Spline redesign Wave C — right inspector full-height + agent bottom dock.
//
// #1704 (the user's call, 2026-10-20) reversed the agent's placement: chat is a
// full-height column at the window's far right, and the inspector floats over
// the viewport to its left. WC#1/WC#2 are updated on purpose to that layout.
//
// Falsifiable acceptance for the layout move: the agent left the cramped 280px
// right column for a full-width always-on bottom dock, and the inspector now
// owns the full-height right column. The old RightDrawer is gone. §196 holds:
// the same AgentChat drives from its new home.
//
// REF: docs/UI-SPEC.md §5.5, §5.8; THESIS §15, §196.

import { expect, test } from './_fixtures';

// #1952 — works inside the outliner / inspector, so it runs with both panels open (see _fixtures).
test.use({ sidePanels: 'open' });

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

test('WC#1 the agent is the full-height column at the far right (#1704)', async ({ page }) => {
  // The old 280px RightDrawer no longer exists.
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  const dock = page.getByTestId('agent-dock');
  await expect(dock).toBeVisible();
  const column = await page.getByTestId('agentdock-slot').boundingBox();
  const layoutBox = await page.getByTestId('layout').boundingBox();
  const main = await page.getByTestId('viewport-slot').boundingBox();
  if (!column || !layoutBox || !main) throw new Error('missing boxes');
  // Flush with the window's right edge, wider than the old 280px drawer.
  expect(Math.abs(column.x + column.width - (layoutBox.x + layoutBox.width))).toBeLessThan(2);
  expect(column.width).toBeGreaterThan(320);
  // Full height: from the viewport's top to the window's bottom, beside the viewport.
  expect(Math.abs(column.y - main.y)).toBeLessThan(2);
  expect(Math.abs(column.y + column.height - (layoutBox.y + layoutBox.height))).toBeLessThan(2);
  expect(main.x + main.width).toBeLessThanOrEqual(column.x + 1);
});

test('WC#2 inspector is a tall floating island near the viewport right edge', async ({ page }) => {
  // UX-BACKLOG #2 — the inspector is no longer a docked right column; it floats
  // as a rounded island over the full-bleed viewport. It still hugs the
  // viewport's right edge (a small island gap of ~12px, not flush) and stays
  // tall. #1704 — the viewport now ends at the chat column, so that is the edge.
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toBeVisible();
  const box = await inspector.boundingBox();
  const layoutBox = await page.getByTestId('layout').boundingBox();
  const main = await page.getByTestId('viewport-slot').boundingBox();
  if (!box || !layoutBox || !main) throw new Error('missing boxes');
  const mainRight = main.x + main.width;
  expect(box.x + box.width).toBeGreaterThan(mainRight - 24);
  expect(box.x + box.width).toBeLessThanOrEqual(mainRight);
  // Tall: still spans a large fraction of the layout height.
  expect(box.height).toBeGreaterThan(layoutBox.height * 0.4);
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
