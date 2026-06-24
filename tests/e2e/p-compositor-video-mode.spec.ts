// Compositor spine 1c.1 — Video mode (the third editor space). Falsifiable
// against the REAL app: the segmented switcher enters Video mode (data-space
// flips, the video surface mounts), the empty-state shows until a comp exists,
// and File ▸ New Composition (or the empty-state CTA) creates a Composition node
// → the comp shell replaces the empty state. Unwiring the switcher, the slot, or
// createNewComposition drops one of these assertions.

import { expect, test } from './_fixtures';

interface DagWindow {
  __basher_dag?: {
    getState: () => { state: { nodes: Record<string, { type: string }> } };
  };
}

function compositionCount(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const nodes = w.__basher_dag?.getState().state.nodes ?? {};
    return Object.values(nodes).filter((n) => n.type === 'Composition').length;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
});

test('switcher enters Video mode and shows the empty-state', async ({ page }) => {
  const layout = page.getByTestId('layout');
  await expect(layout).toHaveAttribute('data-space', 'view3d');

  await page.getByTestId('space-switch-video').click();
  await expect(layout).toHaveAttribute('data-space', 'video');
  await expect(page.getByTestId('video-slot')).toBeVisible();
  await expect(page.getByTestId('video-mode-empty')).toBeVisible();

  // No composition yet → the comp shell is absent.
  await expect(page.getByTestId('video-mode-viewer')).toHaveCount(0);
  expect(await compositionCount(page)).toBe(0);
});

test('New Composition creates a comp and shows the comp shell', async ({ page }) => {
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();

  await expect(page.getByTestId('video-mode-viewer')).toBeVisible();
  await expect(page.getByTestId('video-mode-comp-name')).toHaveText('Composition 1');
  await expect(page.getByTestId('video-mode-empty')).toHaveCount(0);
  expect(await compositionCount(page)).toBe(1);
});

test('File ▸ New Composition enters Video mode from 3D', async ({ page }) => {
  const layout = page.getByTestId('layout');
  await expect(layout).toHaveAttribute('data-space', 'view3d');

  await page.getByTestId('menu-file-button').click();
  await page.getByTestId('menu-file-new-composition').click();

  await expect(layout).toHaveAttribute('data-space', 'video');
  await expect(page.getByTestId('video-mode-comp-name')).toHaveText('Composition 1');
  expect(await compositionCount(page)).toBe(1);
});
