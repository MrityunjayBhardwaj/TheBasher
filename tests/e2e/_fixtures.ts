// Playwright extended test fixture — pre-snapshot focus-clear.
//
// Why this file exists (D-W8-2 + H30 mitigation):
//   P6 W8 C3 adds `focus-visible:ring-1 focus-visible:ring-accent` to every
//   interactive element across the chrome (R1-R5/R7/R8/R9). Without
//   intervention, any Playwright `toHaveScreenshot` call that captures a
//   region containing a focused element would paint the new ring into the
//   baseline. H30 (overlay paint into screenshot bounds) makes this a
//   silent baseline-shift trap — pixel diffs would fail intermittently
//   based on whatever element happened to hold focus at the moment of
//   capture.
//
//   The fix locks the focus-clear at the fixture boundary so no per-spec
//   maintenance is required. Every `page.screenshot(...)` call is wrapped
//   to blur `document.activeElement` BEFORE Playwright captures pixels.
//
// SCOPE OF THE INTERCEPT (self-review correction):
//   This fixture patches `page.screenshot` ONLY. It does NOT intercept:
//     - `locator.screenshot()` / `elementHandle.screenshot()`
//     - `expect(locator).toHaveScreenshot(...)` (locator-targeted matcher)
//   These go through different Playwright internals and bypass the page
//   patch. Today the existing pixel-diff suite (postfx-beauty.png +
//   component snapshots) targets `expect(page).toHaveScreenshot(...)` or
//   `page.screenshot(...)` exclusively, so the H30 hole is closed for
//   current specs. If a future spec uses `locator.toHaveScreenshot(...)`
//   while an element is focused inside the locator's subtree, the H30
//   trap returns. Tracked as a follow-up issue; the long-term fix is to
//   also wrap `Locator.prototype.screenshot` or use a custom matcher.
//
// Lifecycle (the only async question in the W8 wiring):
//   1. Spec reaches `expect(page).toHaveScreenshot(...)` — sync intent
//   2. Playwright internally calls `page.screenshot(...)` — async
//   3. This wrapper intercepts → awaits `page.evaluate(blur)` — async
//   4. Original `page.screenshot` proceeds — async
//   5. Pixel-diff runs against baseline
//
//   CRITICAL: step 3 must complete BEFORE step 4. The `await` below is
//   the lifecycle gate. Fire-and-forget would race the focus-clear
//   against the capture and produce flaky baselines — the textbook H30
//   failure mode.
//
// Usage:
//   import { test, expect } from './_fixtures';
//   ... rest of spec unchanged.
//
// Why a fixture file and not `playwright.config.ts`:
//   `test.extend({ page })` only attaches to a `test` object — it cannot
//   live in `playwright.config.ts`, which holds project-level config
//   (testDir / projects / reporter). The plan's monkey-patch route
//   collapses to this same shape: extend `test`, monkey-patch screenshot
//   inside the page fixture. Specs opt in by importing from here.
//
// REF: D-W8-2 (locked focus-ring treatment + fixture wiring);
//      .anvi/hetvabhasa.md H30 (the trap this mitigates);
//      memory/project_p6_w8_plan.md C3.1.

import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    const originalScreenshot = page.screenshot.bind(page);
    // Monkey-patch — every `page.screenshot(...)` (and therefore every
    // `expect(page).toHaveScreenshot(...)`) routes through this wrapper.
    // The `await` is non-negotiable per the lifecycle comment above.
    page.screenshot = (async (...args: Parameters<typeof originalScreenshot>) => {
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        el?.blur();
      });
      return originalScreenshot(...args);
    }) as typeof page.screenshot;
    await use(page);
  },
});

export { expect };
