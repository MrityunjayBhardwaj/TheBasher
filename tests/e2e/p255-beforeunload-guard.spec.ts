// #255 — the beforeunload guard: closing / reloading with UNSAVED changes must
// trigger the browser's native "leave site?" prompt, but a clean project must
// not nag. Observed via a synthetic cancelable 'beforeunload' event — the guard
// calls preventDefault() only when the project is dirty.
//
// Falsifiable: remove the beforeunload listener (or its dirty check) → the
// dirty-state assertion below sees defaultPrevented === false and fails.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag?: { getState: () => { dispatch: (op: unknown, a?: string, l?: string) => unknown } };
}

function dispatchBeforeUnload(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

test('beforeunload prompts only when there are unsaved changes', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
    timeout: 15000,
  });
  await page.waitForTimeout(400);

  // Clean (just booted / resumed): no dirty dot, unload not blocked.
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);
  expect(await dispatchBeforeUnload(page)).toBe(false);

  // A real edit flips the project dirty.
  await page.evaluate(() => {
    (window as unknown as W)
      .__basher_dag!.getState()
      .dispatch(
        { type: 'setParam', nodeId: 'n_box', paramPath: 'size', value: [2, 2, 2] },
        'user',
        'p255 edit',
      );
  });
  await expect(page.getByTestId('project-tab-dirty-dot')).toBeVisible();

  // Now the unload is blocked (native prompt would show).
  expect(await dispatchBeforeUnload(page)).toBe(true);
});
