// P6 W2 acceptance — TopToolbar + ToolRail + ComfyStatusIndicator wiring.
//
// Coverage anchored to UI-SPEC §11 #12 + §11 #13 + §5.3 + §5.4:
//   - keyboard 1/2/3/4 sets mode (canonical, single keyboard layer)
//   - keyboard Q/W/E/R sets activeTool (when mode ∈ {edit, animate})
//   - ToolRail click drives the same activeTool path
//   - ToolRail collapse persists via chromeStore
//   - ComfyStatusIndicator visible in chrome with capability-derived state
//   - TopToolbar mode pill click sets mode
//   - Director Cut "Present" button enters director mode
//
// REF: docs/UI-SPEC.md §5.3, §5.4, §5.10, §6.2, §11.

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    // Clean up persistent state so collapse-persistence test starts from
    // the documented default (chromeStore false on first visit).
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
});

test('P6.W2#1 keyboard 1/2/3/4 sets mode = edit/run/animate/director', async ({ page }) => {
  await page.keyboard.press('3');
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'animate');
  await page.keyboard.press('2');
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'run');
  await page.keyboard.press('4');
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'director');
  await page.keyboard.press('1');
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'edit');
});

test('P6.W2#2 TopToolbar mode pill click sets mode', async ({ page }) => {
  await page.getByTestId('top-toolbar-mode-animate').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'animate');
  await page.getByTestId('top-toolbar-mode-edit').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'edit');
});

test('P6.W2#3 keyboard Q/W/E/R sets editorStore.activeTool', async ({ page }) => {
  // editorStore is exposed in dev via window.__basher_editor.
  await page.keyboard.press('w');
  await expect
    .poll(async () => await page.evaluate(() => (window as any).__basher_editor.getState().activeTool))
    .toBe('translate');
  await page.keyboard.press('e');
  await expect
    .poll(async () => await page.evaluate(() => (window as any).__basher_editor.getState().activeTool))
    .toBe('rotate');
  await page.keyboard.press('r');
  await expect
    .poll(async () => await page.evaluate(() => (window as any).__basher_editor.getState().activeTool))
    .toBe('scale');
  await page.keyboard.press('q');
  await expect
    .poll(async () => await page.evaluate(() => (window as any).__basher_editor.getState().activeTool))
    .toBe('select');
});

test('P6.W2#4 ToolRail click sets activeTool through the same path', async ({ page }) => {
  await page.getByTestId('tool-rail-rotate').click();
  await expect
    .poll(async () => await page.evaluate(() => (window as any).__basher_editor.getState().activeTool))
    .toBe('rotate');
  await page.getByTestId('tool-rail-translate').click();
  await expect
    .poll(async () => await page.evaluate(() => (window as any).__basher_editor.getState().activeTool))
    .toBe('translate');
});

test('P6.W2#5 ToolRail collapse toggles + persists across reload', async ({ page }) => {
  // Default: expanded.
  await expect(page.getByTestId('layout')).toHaveAttribute('data-tool-rail-collapsed', 'false');
  await page.getByTestId('tool-rail-toggle').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-tool-rail-collapsed', 'true');
  // Reload — collapse should survive (chromeStore persists to localStorage).
  await page.reload();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-tool-rail-collapsed', 'true');
  // Toggle back so the next test starts from default.
  await page.getByTestId('tool-rail-toggle').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-tool-rail-collapsed', 'false');
});

test('P6.W2#6 ComfyStatusIndicator renders with capability-derived state', async ({ page }) => {
  const ind = page.getByTestId('comfy-status-indicator');
  await expect(ind).toBeVisible();
  // Boot wiring installs StubComfyUICapability for e2e (boot.ts:162-168);
  // initial state should be 'stub' until the first probe (which only
  // fires on hover or in run mode).
  await expect(ind).toHaveAttribute('data-state', 'stub');
});

test('P6.W2#7 Director Cut "Present" button enters director mode', async ({ page }) => {
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'director');
  // Esc returns to edit (regression on universal Esc handler).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'edit');
});
