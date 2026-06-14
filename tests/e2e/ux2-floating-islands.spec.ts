// UX-BACKLOG #2 — floating-island panels (Spline-style).
//
// Slice 1 (side islands): the outliner (left) + inspector (right) are detached,
// rounded islands floating OVER a full-bleed viewport — NOT docked grid columns
// that reserve space. Falsifiable against the real DOM:
//
//   - The viewport <main> spans the full layout width (no reserved side columns).
//   - Each side panel is position:absolute (a floating island), top-anchored,
//     hugging its edge, and STOPS SHORT of the bottom (the reserved band that
//     keeps the bottom-right orbit gizmo + Persp/Ortho and the bottom-center
//     stack clear).
//   - A right-click ON a panel does NOT bubble to the viewport and open the Add
//     menu (the islands live inside <main>, so propagation must be stopped);
//     a right-click on the empty viewport still opens it (control).
//   - V35: collapsing a panel keeps its expand affordance reachable.
//
// Reverting the grid→islands change (panels back as docked columns) flips the
// position:absolute + full-bleed-width assertions → these fail.

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

test('#2.1 the viewport is full-bleed — no reserved side columns', async ({ page }) => {
  const main = await page.getByTestId('viewport-slot').boundingBox();
  const layout = await page.getByTestId('layout').boundingBox();
  if (!main || !layout) throw new Error('missing boxes');
  // The viewport <main> spans (essentially) the full layout width. Revert to the
  // tree | viewport | inspector grid → main shrinks by ~560px → this fails.
  expect(main.width).toBeGreaterThan(layout.width * 0.98);
});

for (const { id, edge } of [
  { id: 'tree-slot', edge: 'left' as const },
  { id: 'inspector-slot', edge: 'right' as const },
]) {
  test(`#2.2 the ${id} is a floating island over the viewport, top-anchored, bottom-clear`, async ({
    page,
  }) => {
    const island = page.getByTestId(id);
    await expect(island).toBeVisible();
    // Floating: absolutely positioned (not a grid/flow column).
    const position = await island.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe('absolute');

    const box = await island.boundingBox();
    const main = await page.getByTestId('viewport-slot').boundingBox();
    if (!box || !main) throw new Error('missing boxes');
    // Hugs its edge with a small island gap (floats over, not flush/reserved).
    if (edge === 'left') {
      expect(box.x - main.x).toBeLessThan(24);
    } else {
      expect(main.x + main.width - (box.x + box.width)).toBeLessThan(24);
    }
    // Top-anchored, and STOPS SHORT of the bottom so the bottom widget band
    // (orbit gizmo / Persp-Ortho / the bottom-center stack) stays clear.
    expect(box.y - main.y).toBeLessThan(24);
    expect(main.y + main.height - (box.y + box.height)).toBeGreaterThan(100);
  });
}

test('#2.3 a right-click on a panel does NOT open the viewport Add menu', async ({ page }) => {
  // Control: right-click on the empty viewport opens the Add menu.
  await page.getByTestId('viewport-slot').click({ button: 'right', position: { x: 400, y: 400 } });
  await expect(page.getByTestId('add-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('add-menu')).toHaveCount(0);

  // A right-click on the outliner island must NOT bubble to <main> and re-open
  // it (the island stops propagation). Revert the stopPropagation → this fails.
  await page.getByTestId('tree-slot').click({ button: 'right', position: { x: 40, y: 200 } });
  await expect(page.getByTestId('add-menu')).toHaveCount(0);
});

test('#2.4 V35 — collapsing the outliner island keeps its expand toggle reachable', async ({
  page,
}) => {
  await page.getByTestId('left-sidebar-collapse-toggle').click();
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'true');
  // The expand affordance is still mounted + visible inside the collapsed island.
  await expect(page.getByTestId('left-sidebar-expand-toggle')).toBeVisible();
  await page.getByTestId('left-sidebar-expand-toggle').click();
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'false');
});
