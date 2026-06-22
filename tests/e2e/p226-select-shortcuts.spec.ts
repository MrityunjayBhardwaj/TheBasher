// #226 Slice 3 — Blender selection-shortcut parity. A = Select-All (the Add menu
// moved to Shift+A only), Alt+A = Deselect-All, Ctrl/Cmd+I = Invert. Select-All
// and Invert operate on the FULL selectable universe (children + lights + camera),
// matching box-select and Blender ("A selects everything").

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface ShortcutWindow {
  __basher_selection: {
    getState: () => {
      selectedNodeIds: ReadonlySet<string>;
      primaryNodeId: string | null;
      select: (id: string | null) => void;
    };
  };
}

const selection = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as ShortcutWindow).__basher_selection.getState();
    return { ids: [...s.selectedNodeIds].sort(), primary: s.primaryNodeId };
  });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as unknown as ShortcutWindow).__basher_selection),
    { timeout: 15000 },
  );
  // Focus the body and clear any boot selection (click empty viewport).
  await page.locator('[data-testid="viewport"]').click({ position: { x: 640, y: 160 } });
});

test('bare A selects the full universe — children, lights AND camera', async ({ page }) => {
  await page.keyboard.press('a');
  const all = await selection(page);
  // Default project: a box (child), a light, and the camera — all three.
  expect(all.ids).toContain('n_box');
  expect(all.ids).toContain('n_camera');
  expect(all.ids).toContain('n_light');
});

test('Alt+A deselects all', async ({ page }) => {
  await page.keyboard.press('a');
  expect((await selection(page)).ids.length).toBeGreaterThan(0);
  await page.keyboard.press('Alt+a');
  expect(await selection(page)).toEqual({ ids: [], primary: null });
});

test('Ctrl/Cmd+I inverts the selection over the full universe', async ({ page }) => {
  await page.keyboard.press('a');
  const all = await selection(page);
  await page.evaluate(() =>
    (window as unknown as ShortcutWindow).__basher_selection.getState().select('n_box'),
  );
  await page.keyboard.press('Control+i');
  const inv = await selection(page);
  expect(inv.ids).not.toContain('n_box');
  expect(inv.ids.length).toBe(all.ids.length - 1);
});

test('Shift+A still opens the Add menu (Add did not lose its binding)', async ({ page }) => {
  await page.keyboard.press('Shift+A');
  await expect(page.getByTestId('add-menu')).toBeVisible();
});
