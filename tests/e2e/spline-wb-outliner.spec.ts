// Spline redesign Wave B — left scene outliner.
//
// Falsifiable acceptance for the always-on Spline-style outliner: the panel
// boots expanded (no chevron-only collapse), rows select with a blue tint, the
// footer Library button opens the EXISTING AssetsPopover (V34 — one path, not a
// second library), and the §196 guardrail holds (the agent surface + Add/Assets
// create paths survive the redesign).
//
// REF: docs/UI-SPEC.md §5.5; vyapti V34 (one pipeline), V35 (reveal reachable);
// THESIS §196 (agent stays first-class).

import { expect, test } from './_fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Fresh persistence so the always-on default (chromeStore boot) applies.
  await page.evaluate(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('basher.chrome.v1');
      localStorage.removeItem('basher.leftSidebar.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
});

test('WB#1 outliner boots expanded by default (always-on, no manual expand)', async ({ page }) => {
  // No dev-seam expand call here — this asserts the BOOT default is expanded.
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('scene-tree')).toBeVisible();
  await expect(page.getByTestId('tree-slot')).toBeVisible();
});

test('WB#2 clicking a row selects it with the blue-tint marker', async ({ page }) => {
  const row = page.getByTestId('scene-tree-row-n_box');
  await expect(row).toBeVisible();
  // Unselected initially.
  await expect(row).not.toHaveAttribute('data-selected', 'true');
  await row.click();
  // Selection marker lands (the Spline blue tint row carries data-selected).
  await expect(row).toHaveAttribute('data-selected', 'true');
});

test('WB#3 footer Library opens the existing AssetsPopover (V34 — one path)', async ({ page }) => {
  await expect(page.getByTestId('library-popover')).toHaveCount(0);
  await page.getByTestId('left-sidebar-library').click();
  await expect(page.getByTestId('library-popover')).toBeVisible();
});

test('WB#4 §196 — agent surface + Add/Assets create paths survive the redesign', async ({
  page,
}) => {
  // The agent stays first-class: AgentChat is mounted in the always-present
  // RightDrawer even though the left panel no longer hosts an agent tab.
  await expect(page.getByTestId('right-drawer')).toBeVisible();
  await expect(page.getByTestId('agent-chat')).toBeVisible();
  // Create paths still reachable on the floating toolbar.
  await expect(page.getByTestId('top-toolbar-add')).toBeVisible();
  await expect(page.getByTestId('top-toolbar-assets')).toBeVisible();
});
