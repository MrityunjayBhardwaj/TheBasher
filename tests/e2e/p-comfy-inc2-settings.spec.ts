// ComfyUI epic — Increment 2: connection layer (settings + Test Connection).
//
// CI-SAFE by design: these assertions need NO live ComfyUI. The deterministic
// boundary check uses a deliberately-unreachable URL → the probe reports
// "○ Unreachable" (proving the probe + status wiring). The "● Connected to a
// real server" path is validated by live OBSERVATION against the local ComfyUI
// (not a CI gate — CI has no server), per the design's verification strategy.

import { test, expect } from './_fixtures';

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTestId('menu-file-button').click();
  await page.getByTestId('menu-file-settings').click();
  await expect(page.getByTestId('settings-modal')).toBeVisible();
}

test.describe('ComfyUI Inc 2 — connection settings', () => {
  test('File ▸ Settings opens the modal showing the default ComfyUI URL', async ({ page }) => {
    await openSettings(page);
    // Default URL is the local ComfyUI the boot probe targets.
    await expect(page.getByTestId('settings-comfy-url')).toHaveValue('http://127.0.0.1:8188');
  });

  test('Test Connection against an unreachable URL reports ○ Unreachable', async ({ page }) => {
    await openSettings(page);
    // A port nothing listens on → the probe fails (connection refused / CORS) →
    // status reflects it. Revert the probe wiring → no status → fails.
    await page.getByTestId('settings-comfy-url').fill('http://127.0.0.1:1');
    await page.getByTestId('settings-comfy-test').click();
    await expect(page.getByTestId('settings-comfy-status')).toContainText('Unreachable', {
      timeout: 15000,
    });
  });

  test('Save persists the URL across a reload (localStorage)', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('settings-comfy-url').fill('http://example.test:9999');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-modal')).toBeHidden();

    // Reload → reopen → the persisted value survives (proves the store hydrates).
    await page.reload();
    await page.getByTestId('menu-file-button').click();
    await page.getByTestId('menu-file-settings').click();
    await expect(page.getByTestId('settings-comfy-url')).toHaveValue('http://example.test:9999');
  });

  test('Cancel discards an unsaved edit (draft-only)', async ({ page }) => {
    await openSettings(page);
    const original = await page.getByTestId('settings-comfy-url').inputValue();
    await page.getByTestId('settings-comfy-url').fill('http://discard.me:1234');
    await page.getByTestId('settings-cancel').click();
    await expect(page.getByTestId('settings-modal')).toBeHidden();
    // Reopen → still the original, the draft was thrown away.
    await page.getByTestId('menu-file-button').click();
    await page.getByTestId('menu-file-settings').click();
    await expect(page.getByTestId('settings-comfy-url')).toHaveValue(original);
  });
});
