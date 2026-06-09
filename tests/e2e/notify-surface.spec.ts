// Notification (toast) surface — #170 render feedback + #148 storage warning.
//
// Observes the REAL DOM (Lokayata): a render fired from the toolbar surfaces a
// success toast; the dismiss button removes it; and a boot that degrades all
// the way to MemoryStorage surfaces the "won't be saved" warning. Each test is
// falsifiable — reverting the wiring (bare render action / no boot warning)
// makes the toast absent and the assertion fail.

import { test, expect } from './_fixtures';

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_dag?: unknown }).__basher_dag),
  );
  await page.waitForTimeout(300); // let the first frame paint (threeRef gl+scene)
}

test.describe('notification surface', () => {
  test('#170 — rendering from the toolbar shows a success toast naming the resolution', async ({
    page,
  }) => {
    await waitReady(page);

    // No toast before the action (the success toast is caused by the click,
    // not pre-existing state).
    await expect(page.getByTestId('toast-success')).toHaveCount(0);

    await page.getByTestId('top-toolbar-render').click();

    // The render completes and a success toast appears. Revert the wiring
    // (call the bare renderActiveProjectToPng that `void`s its result) → no
    // toast → this fails.
    const toast = page.getByTestId('toast-success');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText('1920×1080');
  });

  test('the dismiss button removes a toast', async ({ page }) => {
    await waitReady(page);
    await page.getByTestId('top-toolbar-render').click();
    const toast = page.getByTestId('toast-success');
    await expect(toast).toBeVisible({ timeout: 10_000 });

    await toast.getByTestId('toast-dismiss').click();
    await expect(toast).toHaveCount(0);
  });

  test('#148 — boot on MemoryStorage shows a sticky "won\'t be saved" warning', async ({
    page,
  }) => {
    // Force the OPFS → IndexedDB → Memory chain all the way to Memory, BEFORE
    // any app code runs: make OPFS reject (the #146 shape) AND remove
    // IndexedDB so its isAvailable() probe fails too.
    await page.addInitScript(() => {
      const storage = navigator.storage as unknown as Record<string, unknown>;
      Object.defineProperty(storage, 'getDirectory', {
        configurable: true,
        value: () => Promise.reject(new DOMException('denied', 'SecurityError')),
      });
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    });

    await page.goto('/');
    await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });

    // The storage warning is raised at boot. Revert the boot wiring (no
    // storageFallbackWarning notify) → no toast → this fails. The app still
    // boots (MemoryStorage is a full backend) — this is feedback, not a crash.
    const warn = page.getByTestId('toast-warn');
    await expect(warn).toBeVisible({ timeout: 10_000 });
    await expect(warn).toContainText(/won't be saved/i);
  });
});
