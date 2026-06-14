// #173 — Inspector (R7) per-panel collapse.
//
// chromeStore.inspectorCollapsed + toggleInspector + persistence have existed
// since P6 (UI-SPEC §3.2 / D-UX-5 promised per-panel collapse for every panel,
// incl. R7) but were wired to NOTHING. This suite proves the wiring end-to-end:
//   - NPanel renders the collapse/expand chevrons (side A), and
//   - Layout consumes the flag → the inspector grid column shrinks (side B).
// The column-width assertion is the falsifier: it fails if Layout still
// hardcodes the expanded width (i.e. the NPanel toggle would flip an unread
// flag). ux-overhall: the Spline redesign made the layout 3-col
// (tree | viewport | inspector) and the inspector 300px (Wave C), so the
// inspector is grid column index 2 and the expanded width is 300px.
//
// Mirrors the LeftSidebar collapse coverage in p6-w3-leftsidebar.spec.ts#3.
//
// REF: docs/UI-SPEC.md §3.2, §5.8, D-UX-5, D-UX-23; issue #173.

import { expect, test } from './_fixtures';

// UX-BACKLOG #2 — the inspector is no longer a grid column; it floats as an
// absolute island (`inspector-slot`). The collapse falsifier now reads the
// island's rendered width: 300px expanded, 28px collapsed, 0 in present
// (display:none). Rounded border-box width via getBoundingClientRect.
async function inspectorIslandWidth(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="inspector-slot"]') as HTMLElement | null;
    if (!el) return -1;
    return Math.round(el.getBoundingClientRect().width);
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
  // Expanded column is the full 300px (Spline Wave C inspector width).
  const px = await inspectorIslandWidth(page);
  expect(px).toBe(300);
});

test('#173 collapse → 28px chevron strip; expand → restores 300px (Layout consumes the flag)', async ({
  page,
}) => {
  // Collapse via the header chevron.
  await page.getByTestId('inspector-collapse-toggle').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('inspector-expand-toggle')).toBeVisible();
  // The expanded header toggle is gone (only the strip's expand chevron remains).
  await expect(page.getByTestId('inspector-collapse-toggle')).toHaveCount(0);
  // SIDE B — the falsifier: the Layout grid column actually shrank to 28px.
  // If Layout still hardcoded 300px, this fails even though the flag flipped.
  expect(await inspectorIslandWidth(page)).toBe(28);

  // Expand via the strip chevron.
  await page.getByTestId('inspector-expand-toggle').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('inspector-collapse-toggle')).toBeVisible();
  expect(await inspectorIslandWidth(page)).toBe(300);
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
  expect(await inspectorIslandWidth(page)).toBe(28);
});

test('#173 Present mode hides the inspector entirely regardless of the flag', async ({ page }) => {
  // Expanded (default). Enter Present (the v0.6 #4 re-home for the dissolved
  // `director` mode) via the floating-pill button — all chrome, the inspector
  // column included, collapses to 0 independent of the collapse flag.
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-present', 'true');
  const px = await inspectorIslandWidth(page);
  expect(px).toBe(0);
});
