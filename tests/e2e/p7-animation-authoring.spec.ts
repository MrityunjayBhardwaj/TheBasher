// P7 Animation Authoring — e2e observation gate for the "Animate this"
// director affordance.
//
// Wave D scope (this file, this wave): D2 Auto-Key indicator unmissability +
// D4 Auto-Key commit-handler interception. Wave E adds the rotation-delta
// motion test to this same spec file later.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> } } };
  __basher_viewport?: { getState: () => { timelineDrawerOpen: boolean } };
  __basher_time?: { getState: () => { setTime: (s: number) => void; seconds: number } };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_viewport);
  });
  // Timebar lives in the layout's persistent timeline slot; Animate mode is
  // where keyframe authoring happens (D-UX-1).
  await page.getByTestId('mode-switcher').selectOption('animate');
});

test.describe('P7 D2 — Auto-Key indicator is unmissable (footgun mitigation)', () => {
  test('OFF by default: no record-armed treatment', async ({ page }) => {
    const bar = page.getByTestId('timebar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-autokey', 'off');
    // The dot exists but is the hollow idle ring — NOT the armed filled dot.
    const dot = page.getByTestId('autokey-dot');
    await expect(dot).not.toHaveClass(/bg-record/);
    await expect(page.getByTestId('autokey-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('toggle ON → red dot + tinted header, visible across panel focus changes', async ({ page }) => {
    await page.getByTestId('autokey-toggle').click();

    const bar = page.getByTestId('timebar');
    await expect(bar).toHaveAttribute('data-autokey', 'on');
    // Tinted header treatment present (record-tinted bg + border).
    await expect(bar).toHaveClass(/bg-record\/15/);
    await expect(bar).toHaveClass(/border-record/);
    // Filled, pulsing red record dot.
    const dot = page.getByTestId('autokey-dot');
    await expect(dot).toHaveClass(/bg-record/);
    await expect(dot).toHaveClass(/animate-pulse/);
    await expect(page.getByTestId('autokey-toggle')).toHaveAttribute('aria-pressed', 'true');

    // Move focus into a different panel (the scene tree / inspector area):
    // the indicator must REMAIN — it is global, not focus-scoped.
    await page.getByTestId('timebar-scrub').focus();
    await page.keyboard.press('Tab');
    await expect(bar).toHaveAttribute('data-autokey', 'on');
    await expect(bar).toHaveClass(/bg-record\/15/);
    await expect(dot).toHaveClass(/bg-record/);
  });

  test('toggle OFF again → treatment fully removed', async ({ page }) => {
    const toggle = page.getByTestId('autokey-toggle');
    await toggle.click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
    await toggle.click();
    const bar = page.getByTestId('timebar');
    await expect(bar).toHaveAttribute('data-autokey', 'off');
    await expect(bar).not.toHaveClass(/bg-record\/15/);
    await expect(page.getByTestId('autokey-dot')).not.toHaveClass(/bg-record/);
  });
});
