import { test, expect } from './_fixtures';

// UX backlog #3/#4 — the top-right Save button, "projects ▾" dropdown, and
// ComfyUI STUB/LIVE badge were removed from the chrome; the projects list moved
// into File ▸ Switch Project. Save remains File ▸ Save / Cmd+S (gated by
// p6-w3-leftsidebar P6.W3#5: dirty dot clears after Cmd+S).

async function toEditor(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByText('Starter Scene', { exact: false }).first().click();
  await page.getByTestId('layout').waitFor({ timeout: 20000 });
}

test('#3/#4 the top-right Save / projects / STUB cluster is gone', async ({ page }) => {
  await toEditor(page);
  await expect(page.getByTestId('save-button')).toHaveCount(0);
  await expect(page.getByTestId('projects-menu')).toHaveCount(0);
  await expect(page.getByTestId('comfy-status-indicator')).toHaveCount(0);
  // The project identity breadcrumb stays on the tabs bar.
  await expect(page.getByTestId('project-name')).toHaveCount(1);
});

test('#4 File ▸ Switch Project lists projects and switches the active one', async ({ page }) => {
  await toEditor(page);

  // Guarantee ≥2 projects: duplicate the current one (no prompt). This switches
  // to the copy, so the original becomes the non-current entry to switch back to.
  await page.getByTestId('menu-file').click();
  const before = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  await page.getByTestId('menu-file-duplicate').click();
  await page.waitForFunction(
    (prev) => localStorage.getItem('basher.lastProjectId') !== prev,
    before,
  );
  const dupId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));

  // Open File ▸ Switch Project: now lists ≥2, current copy carries the ✓ tick.
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-file-switch').hover();
  const items = page.locator('[data-testid^="menu-file-switch-"]');
  await expect(items.first()).toBeVisible();
  // The list is fetched async on menu-open; poll until the duplicate lands.
  await expect.poll(() => items.count()).toBeGreaterThanOrEqual(2);

  // Click a project that is NOT the current one (no ✓ tick) → switches to it.
  const other = items.filter({ hasNotText: '✓' }).first();
  await other.click();
  await page.waitForFunction(
    (prev) => localStorage.getItem('basher.lastProjectId') !== prev,
    dupId,
  );
  const endId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  expect(endId).not.toBe(dupId);
});
