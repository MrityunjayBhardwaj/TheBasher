// #146 — boot must survive a context where `navigator.storage.getDirectory`
// EXISTS but rejects with a SecurityError (opaque origin / sandboxed iframe /
// blocked site-data / some private-browsing modes). The user hit this as
// "boot failed: Security error when calling GetDirectory".
//
// Root cause: OpfsStorage.isAvailable() was presence-only, so pickStorage
// selected OPFS and boot died on the first getDirectory() call — the
// IndexedDB/Memory fallback never ran. This test REPRODUCES the failing
// context by overriding getDirectory to reject BEFORE any app code runs, then
// asserts the app boots anyway (the fallback chain engages). It is the
// real-symptom observation behind the unit-level probe tests in
// src/core/storage/storage.test.ts.

import { test, expect } from './_fixtures';

test('boot succeeds when navigator.storage.getDirectory() rejects with SecurityError (#146)', async ({
  page,
}) => {
  // Runs in the page BEFORE the app bundle — exactly the user's runtime shape:
  // the symbol is present, calling it throws.
  await page.addInitScript(() => {
    const storage = navigator.storage as unknown as Record<string, unknown>;
    Object.defineProperty(storage, 'getDirectory', {
      configurable: true,
      value: () => Promise.reject(new DOMException('denied', 'SecurityError')),
    });
  });

  await page.goto('/');

  // The symptom was a boot-error screen ("boot failed: …"). The fix routes
  // around OPFS to the IndexedDB/Memory fallback, so the real app shell mounts.
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/boot failed/i)).toHaveCount(0);

  // And the DAG store is live — boot ran to completion, it didn't just render
  // an empty shell.
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_dag?: unknown }).__basher_dag),
  );
});
