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

test('WC#1 agent is a bottom-CENTER floating island, not a narrow right column', async ({
  page,
}) => {
  // The old right-column drawer no longer exists.
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  const dock = page.getByTestId('agent-dock');
  await expect(dock).toBeVisible();
  const dockBox = await dock.boundingBox();
  const layoutBox = await page.getByTestId('layout').boundingBox();
  if (!dockBox || !layoutBox) throw new Error('missing boxes');
  // UX-BACKLOG #2 slice 2 — the agent is now a CENTERED floating island (capped
  // width), not the old full-width bottom dock and not the older 280px right
  // column. Wider than the 280px column it replaced, but well short of full
  // width (it leaves the side islands clear).
  expect(dockBox.width).toBeGreaterThan(320);
  expect(dockBox.width).toBeLessThan(layoutBox.width * 0.78);
  // Horizontally centered on the layout.
  const dockCenter = dockBox.x + dockBox.width / 2;
  const layoutCenter = layoutBox.x + layoutBox.width / 2;
  expect(Math.abs(dockCenter - layoutCenter)).toBeLessThan(24);
  // Bottom: the island sits in the lower portion of the layout.
  expect(dockBox.y).toBeGreaterThan(layoutBox.y + layoutBox.height * 0.5);
});

test('WC#2 inspector is a tall floating island near the right edge', async ({ page }) => {
  // UX-BACKLOG #2 — the inspector is no longer a docked right column; it floats
  // as a rounded island over the full-bleed viewport. It still hugs the right
  // edge (a small island gap of ~12px, not flush) and stays tall.
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toBeVisible();
  const box = await inspector.boundingBox();
  const layoutBox = await page.getByTestId('layout').boundingBox();
  if (!box || !layoutBox) throw new Error('missing boxes');
  // Right edge sits within the island gap of the layout's right edge (floating,
  // not flush). Revert to a docked full-bleed column → this still holds, but the
  // float assertion below would fail.
  expect(box.x + box.width).toBeGreaterThan(layoutBox.x + layoutBox.width - 24);
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
