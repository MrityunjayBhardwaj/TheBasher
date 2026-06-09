// #173 — Inspector (R7) per-panel collapse.
//
// chromeStore.inspectorCollapsed + toggleInspector + persistence have existed
// since P6 (UI-SPEC §3.2 / D-UX-5 promised per-panel collapse for every panel,
// incl. R7) but were wired to NOTHING. This suite proves the wiring end-to-end:
//   - NPanel renders the collapse/expand chevrons (side A), and
//   - Layout consumes the flag → the inspector grid column shrinks (side B).
// The column-width assertion is the falsifier: it fails if Layout still
// hardcodes 280px (i.e. the NPanel toggle would flip an unread flag).
//
// Mirrors the LeftSidebar collapse coverage in p6-w3-leftsidebar.spec.ts#3.
//
// REF: docs/UI-SPEC.md §3.2, §5.8, D-UX-5, D-UX-23; issue #173.

import { expect, test } from './_fixtures';

// The inspector is the 4th grid column: tree | toolRail | viewport | inspector | drawer.
async function inspectorColumnPx(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const layout = document.querySelector('[data-testid="layout"]') as HTMLElement | null;
    if (!layout) return '';
    const cols = getComputedStyle(layout).gridTemplateColumns.split(' ');
    // 5 columns; index 3 = inspector.
    return cols[3] ?? '';
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Clean persistence so first-visit defaults apply (inspectorCollapsed=false).
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        // ignore
      }
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('basher.chrome.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_chrome?: unknown }).__basher_chrome),
  );
});

test('#173 inspector starts expanded with a collapse chevron in the header', async ({ page }) => {
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('inspector-collapse-toggle')).toBeVisible();
  // Expanded column is the full 280px.
  const px = await inspectorColumnPx(page);
  expect(px).toBe('280px');
});

test('#173 collapse → 28px chevron strip; expand → restores 280px (Layout consumes the flag)', async ({
  page,
}) => {
  // Collapse via the header chevron.
  await page.getByTestId('inspector-collapse-toggle').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('inspector-expand-toggle')).toBeVisible();
  // The expanded header toggle is gone (only the strip's expand chevron remains).
  await expect(page.getByTestId('inspector-collapse-toggle')).toHaveCount(0);
  // SIDE B — the falsifier: the Layout grid column actually shrank to 28px.
  // If Layout still hardcoded 280px, this fails even though the flag flipped.
  expect(await inspectorColumnPx(page)).toBe('28px');

  // Expand via the strip chevron.
  await page.getByTestId('inspector-expand-toggle').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('inspector-collapse-toggle')).toBeVisible();
  expect(await inspectorColumnPx(page)).toBe('280px');
});

test('#173 collapse state persists across reload', async ({ page }) => {
  await page.getByTestId('inspector-collapse-toggle').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_chrome?: unknown }).__basher_chrome),
  );
  // Still collapsed after reload (chromeStore persisted to localStorage).
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');
  expect(await inspectorColumnPx(page)).toBe('28px');
});

test('#173 Director mode hides the inspector entirely regardless of the flag', async ({ page }) => {
  // Expanded (default). Switch to Director via the real mode switcher — the
  // inspector column collapses to 0 (chrome hidden) independent of the flag.
  await page.getByTestId('mode-switcher').selectOption('director');
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'director');
  const px = await inspectorColumnPx(page);
  expect(px).toBe('0px');
});
