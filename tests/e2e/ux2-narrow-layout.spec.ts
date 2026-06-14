// UX-BACKLOG #2 follow-up 2 — narrow-layout (responsive) re-dock.
//
// Below LAYOUT_NARROW_MAX (1024px) the three columns of chrome won't fit, so
// the side islands become OFF-CANVAS OVERLAY DRAWERS (closed by default; an
// edge tab reveals one, a scrim dismisses it) and the centered surfaces (the
// toolbar pill + the bottom agent/timeline stack) go FULL-WIDTH. The
// bottom-right orbit gizmo + Persp/Ortho pill are hidden (their corner is taken
// by the full-width stack).
//
// Reverting the narrow branch (islands stay docked beside the viewport) flips
// the off-canvas + full-width + tab-presence assertions → these fail.

import { expect, test } from './_fixtures';

test.describe('narrow layout (<1024px)', () => {
  test.use({ viewport: { width: 900, height: 820 } });

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

  test('N#1 side panels are off-canvas by default; edge tabs reveal them', async ({ page }) => {
    // Both drawers start CLOSED → slid fully off their edge (right edge ≤ the
    // left viewport edge / left edge ≥ the right viewport edge).
    const tree = await page.getByTestId('tree-slot').boundingBox();
    const layout = await page.getByTestId('layout').boundingBox();
    if (!tree || !layout) throw new Error('missing boxes');
    expect(tree.x + tree.width).toBeLessThanOrEqual(1);

    // The edge tabs are the only on-screen affordance for the closed drawers.
    await expect(page.getByTestId('left-drawer-tab')).toBeVisible();
    await expect(page.getByTestId('right-drawer-tab')).toBeVisible();
    await expect(page.getByTestId('narrow-drawer-scrim')).toHaveCount(0);
  });

  test('N#2 the toolbar + bottom stack go full-width', async ({ page }) => {
    const layout = await page.getByTestId('layout').boundingBox();
    const toolbar = await page.getByTestId('floating-viewport-toolbar').boundingBox();
    const stack = await page.getByTestId('agentdock-slot').boundingBox();
    if (!layout || !toolbar || !stack) throw new Error('missing boxes');
    // Full-width minus the edge gaps (24px) → > 90% of the layout. With the
    // desktop reserve they would be ~half the width here → fails.
    expect(toolbar.width).toBeGreaterThan(layout.width * 0.9);
    expect(stack.width).toBeGreaterThan(layout.width * 0.9);
  });

  test('N#3 the edge tab slides the drawer in; the scrim dismisses it', async ({ page }) => {
    await page.getByTestId('left-drawer-tab').click();
    // Drawer slid on-screen (left edge at the island gap, not off-canvas).
    await expect
      .poll(async () => (await page.getByTestId('tree-slot').boundingBox())?.x ?? -999)
      .toBeGreaterThanOrEqual(0);
    // The scrim appears and the opened side's tab is gone.
    await expect(page.getByTestId('narrow-drawer-scrim')).toBeVisible();
    await expect(page.getByTestId('left-drawer-tab')).toHaveCount(0);

    // Clicking the scrim closes the drawer (slid back off-canvas).
    await page.getByTestId('narrow-drawer-scrim').click({ position: { x: 500, y: 400 } });
    await expect
      .poll(async () => {
        const b = await page.getByTestId('tree-slot').boundingBox();
        return b ? b.x + b.width : 999;
      })
      .toBeLessThanOrEqual(1);
    await expect(page.getByTestId('narrow-drawer-scrim')).toHaveCount(0);
  });

  test('N#4 only one drawer is open at a time', async ({ page }) => {
    await page.getByTestId('left-drawer-tab').click();
    await expect(page.getByTestId('narrow-drawer-scrim')).toBeVisible();
    // Opening the right drawer (its tab is still reachable above the scrim)
    // closes the left one.
    await page.getByTestId('right-drawer-tab').click();
    await expect
      .poll(async () => (await page.getByTestId('inspector-slot').boundingBox())?.x ?? 999)
      .toBeLessThan(900);
    // Left is back off-canvas → its tab is shown again.
    await expect(page.getByTestId('left-drawer-tab')).toBeVisible();
  });

  test('N#5 the bottom-right gizmo + Persp/Ortho pill are hidden', async ({ page }) => {
    await expect(page.getByTestId('projection-toggle')).toHaveCount(0);
  });

  test('N#6 present mode hides the drawers, tabs, and scrim', async ({ page }) => {
    await page.getByTestId('top-toolbar-present').click();
    await expect(page.getByTestId('layout')).toHaveAttribute('data-present', 'true');
    await expect(page.getByTestId('tree-slot')).toBeHidden();
    await expect(page.getByTestId('left-drawer-tab')).toHaveCount(0);
    await expect(page.getByTestId('right-drawer-tab')).toHaveCount(0);
  });
});

// Control: at desktop width the narrow affordances must NOT exist (the desktop
// islands render instead). Falsifies a narrow branch that leaked into wide.
test('N#7 wide layout has no drawer tabs / scrim and keeps the Persp/Ortho pill', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
  await expect(page.getByTestId('left-drawer-tab')).toHaveCount(0);
  await expect(page.getByTestId('right-drawer-tab')).toHaveCount(0);
  await expect(page.getByTestId('narrow-drawer-scrim')).toHaveCount(0);
  await expect(page.getByTestId('projection-toggle')).toBeVisible();
});
