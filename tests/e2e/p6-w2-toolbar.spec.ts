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

import { expect, test } from './_fixtures';

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

interface EditorWindow {
  __basher_editor: { getState: () => { activeTool: string } };
}

function readActiveTool(): string {
  return (window as unknown as EditorWindow).__basher_editor.getState().activeTool;
}

test('P6.W2#1 keys 1/2/3/4 are unbound — the operational mode enum is gone (v0.6 #4)', async ({
  page,
}) => {
  // The mode enum (edit/run/animate/director) was dissolved; keys 1/2/3/4 no
  // longer bind to anything. Pressing them must NOT enter present or change the
  // active tool.
  const before = await page.evaluate(readActiveTool);
  for (const k of ['1', '2', '3', '4']) await page.keyboard.press(k);
  await expect(page.getByTestId('layout')).not.toHaveAttribute('data-present', 'true');
  expect(await page.evaluate(readActiveTool)).toBe(before);
});

test('P6.W2#2 the operational mode pill is gone (dissolved in v0.6 #4)', async ({ page }) => {
  await expect(page.getByTestId('top-toolbar-mode-pill')).toHaveCount(0);
  await expect(page.getByTestId('top-toolbar-mode-animate')).toHaveCount(0);
  await expect(page.getByTestId('top-toolbar-mode-edit')).toHaveCount(0);
});

test('P6.W2#3 keyboard Q/W/E/R sets editorStore.activeTool', async ({ page }) => {
  // editorStore is exposed in dev via window.__basher_editor.
  await page.keyboard.press('w');
  await expect.poll(async () => await page.evaluate(readActiveTool)).toBe('translate');
  await page.keyboard.press('e');
  await expect.poll(async () => await page.evaluate(readActiveTool)).toBe('rotate');
  await page.keyboard.press('r');
  await expect.poll(async () => await page.evaluate(readActiveTool)).toBe('scale');
  await page.keyboard.press('q');
  await expect.poll(async () => await page.evaluate(readActiveTool)).toBe('select');
});

test('P6.W2#4 ToolRail click sets activeTool through the same path', async ({ page }) => {
  await page.getByTestId('tool-rail-rotate').click();
  await expect.poll(async () => await page.evaluate(readActiveTool)).toBe('rotate');
  await page.getByTestId('tool-rail-translate').click();
  await expect.poll(async () => await page.evaluate(readActiveTool)).toBe('translate');
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
  // fires on hover or while playback is active).
  await expect(ind).toHaveAttribute('data-state', 'stub');
});

test('P6.W2#7 "Present" button enters present mode; Esc exits', async ({ page }) => {
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-present', 'true');
  // Esc dismisses the topmost transient — here, present (regression on the
  // Esc ladder that replaced the old setMode('edit')).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('layout')).not.toHaveAttribute('data-present', 'true');
});
