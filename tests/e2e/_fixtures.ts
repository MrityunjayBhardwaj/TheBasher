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
    // v0.6 #4 W4 — first-run routing. boot now lands a TRUE first run (no
    // persisted `basher.lastProjectId`) on the pre-editor HOME, not the editor.
    // Every editor spec does `goto('/')` and expects the editor, so seed the
    // resume target to the canonical default project. CONDITIONAL — only set it
    // when ABSENT, so a spec that creates/switches projects and then reloads
    // still resumes ITS project (we never clobber a persisted value on reload).
    // The home spec (p6-w4-home) registers a LATER init script that removes /
    // overrides this to exercise the first-run + stale-id paths.
    await page.addInitScript(() => {
      try {
        if (localStorage.getItem('basher.lastProjectId') == null) {
          localStorage.setItem('basher.lastProjectId', 'default');
        }
      } catch {
        /* storage disabled — boot falls back to home, the home spec covers it */
      }
    });
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright fixture `use`, not a React Hook
    await use(page);
  },
});

export { expect };

/**
 * Wait until the initial bounds-fit has finished moving the camera (#989).
 *
 * ── WHY ANY SPEC THAT READS THE CAMERA NEEDS THIS ────────────────────────────────────
 *
 * On boot `EditorViewCamera` runs a one-time fit that re-frames the scene, and it does
 * not stop on a clock — it stops after the scene bounds hold steady for 45 consecutive
 * FRAMES. While it runs it OWNS the camera, and moving an object changes the bounds, so
 * an active fit re-frames on the new centre.
 *
 * That is indistinguishable from a view lock following, and it breaks a spec in BOTH
 * directions:
 *
 *   · a control arm asserting the object LEFT frame unlocked fails, because the fit
 *     centred it — measured 6 of 6 with `active: true` at the read;
 *   · a locked arm asserting the object STAYED framed passes for the wrong reason,
 *     because the fit produces the same readings. Measured with NO lock taken at all:
 *     the pivot moved 14.000 and ndc x was 0.000 — exactly what the locked arm cites as
 *     evidence the lock works.
 *
 * The second is the worse one: a green that means nothing.
 *
 * A longer sleep moves the odds and fixes neither, because 45 still frames is not a
 * duration — a slower runner or a heavier scene pushes it out again. Waiting for the
 * condition is the only form that cannot flake.
 *
 * ⚠️ The fit exits for good; it is a one-time pass, not a constraint. Measured: after it
 * settles, eight further edits leave the pivot pinned while the object walks off to
 * ndc −2.03. So await this ONCE after each load, and never again.
 *
 * REF: src/viewport/EditorViewCamera.tsx (the fit callback and its `__basher_view_fit`
 *      seam); issues #989, #856.
 */
export async function settleViewFit(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __basher_view_fit?: { active: boolean } }).__basher_view_fit
        ?.active === false,
    undefined,
    { timeout: 20_000 },
  );
}
