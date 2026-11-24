// Spline redesign Wave B — left scene outliner.
//
// Falsifiable acceptance for the Spline-style outliner: since #1952 the panel boots as a rail
// ("the viewport is the film") and its icon opens it; rows select with a blue tint, the
// library has one home (V34 — since #1707 the bottom drawer's Library tab), and
// the §196 guardrail holds (the agent surface + Add/Assets
// create paths survive the redesign).
//
// REF: docs/UI-SPEC.md §5.5; vyapti V34 (one pipeline), V35 (reveal reachable);
// THESIS §196 (agent stays first-class).

import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';
import { toolbarControl } from './_toolbar';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Fresh persistence so the first-start default (chromeStore boot: a rail, #1952) applies.
  await page.evaluate(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('basher.chrome.v1');
      localStorage.removeItem('basher.leftSidebar.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
});

test('WB#1 / #1952 outliner boots as a rail; its icon opens the tree', async ({ page }) => {
  // No dev-seam expand call here — this asserts the BOOT default.
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('scene-tree')).toHaveCount(0);
  await page.getByTestId('left-sidebar-expand-toggle').click();
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('scene-tree')).toBeVisible();
  await expect(page.getByTestId('tree-slot')).toBeVisible();
});

test('WB#2 clicking a row selects it with the blue-tint marker', async ({ page }) => {
  await page.getByTestId('left-sidebar-expand-toggle').click();
  const row = page.getByTestId('scene-tree-row-n_box');
  await expect(row).toBeVisible();
  // Unselected initially.
  await expect(row).not.toHaveAttribute('data-selected', 'true');
  await row.click();
  // Selection marker lands (the Spline blue tint row carries data-selected).
  await expect(row).toHaveAttribute('data-selected', 'true');
});

test("WB#3 the asset Library is the bottom drawer's Library tab (#1707 — one home, V34)", async ({
  page,
}) => {
  // Drawer closed → the library is not yet rendered.
  await expect(page.getByTestId('library-popover')).toHaveCount(0);
  // The Library tab reveals it in the drawer (re-homed from the left panel's
  // Assets tab, which had re-homed it from the footer + floating popover).
  await openDrawerTab(page, 'library');
  await expect(page.getByTestId('library-pane').getByTestId('library-popover')).toBeVisible();
  // One home: nothing of it in the left panel.
  await expect(page.getByTestId('left-sidebar-tab-assets')).toHaveCount(0);
});

test('WB#4 §196 — agent surface + Add/Assets create paths survive the redesign', async ({
  page,
}) => {
  // The agent stays first-class: AgentChat is mounted in the AgentDock inside the
  // right-hand chat column (#1704) even though the left panel no longer hosts an
  // agent tab.
  await expect(page.getByTestId('agent-dock')).toBeVisible();
  await expect(page.getByTestId('agent-chat')).toBeVisible();
  // Create paths still reachable on the floating toolbar.
  await expect(await toolbarControl(page, 'top-toolbar-add')).toBeVisible();
  await expect(await toolbarControl(page, 'top-toolbar-assets')).toBeVisible();
});
