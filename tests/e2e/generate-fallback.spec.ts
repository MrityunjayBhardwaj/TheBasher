// #804 — a configured Tripo key that cannot be used must SAY SO.
//
// The defect: `pickModelGeneration` probed the service, got false for any of
// four unrelated reasons, and returned the stub. The stub emits a real GLB that
// imports and renders, and its own `isAvailable()` is unconditionally true — so
// a synthesised mesh arrived looking exactly like a generation, with a key
// configured and nothing anywhere saying the service was never reached.
//
// 🔑 THIS HAS E2E AS ITS ONLY WITNESS, and for the same structural reason
// `generate-panel.spec.ts` gives: the project has no React Testing Library (W2
// acceptance gate #15 forbids new external deps). The classification and the
// wording are unit-tested as functions in `src/core/modelgen/tripoProbe.test.ts`;
// that the app WIRES them to a surface a person sees is only observable here.
//
// Hermetic on purpose. The route is intercepted rather than allowed through to
// the dev proxy, because a real 401 would make CI depend on Tripo being up and
// on a key existing — and the thing under test is our reaction to a refusal, not
// Tripo's ability to issue one.
//
// REF: src/app/boot.ts (the wiring); src/core/modelgen/index.ts
//      (`pickModelGeneration`'s report); src/app/stores/assetErrorStore.ts.

import { test, expect } from './_fixtures';

const SETTINGS_KEY = 'basher.settings.v1';

/** Seed a key so the probe actually runs — with none, the stub is the intended
 *  default and reporting would be noise. */
async function withKey(page: import('@playwright/test').Page, key: string): Promise<void> {
  await page.addInitScript(
    ([storageKey, apiKey]) => {
      const raw = localStorage.getItem(storageKey);
      const blob: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      blob.tripoApiKey = apiKey;
      localStorage.setItem(storageKey, JSON.stringify(blob));
    },
    [SETTINGS_KEY, key] as const,
  );
}

async function askForAModel(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('top-toolbar-assets').click();
  await expect(page.getByTestId('generate-panel')).toBeVisible();
  await page.getByTestId('generate-kind-model').click();
  await page.getByTestId('generate-prompt').fill('a worn leather armchair');
  await page.getByTestId('generate-submit').click();
}

test('a refused key is reported, not swallowed (#804)', async ({ page }) => {
  await withKey(page, 'tsk_a_key_the_service_will_refuse');
  // Exactly what Tripo answers a bad credential.
  await page.route('**/__tripo/**', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 1002, message: 'Authentication failed' }),
    }),
  );

  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await askForAModel(page);

  const row = page.getByTestId('asset-error-row-Text-to-3D');
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The cause survives all the way to the surface. A generic "generation
  // failed" would pass a weaker assertion while telling a person nothing about
  // which of the four situations they are in.
  await expect(row).toContainText('refused the API key');
  await expect(row).toContainText('offline stub');
});

test('an unreachable service names the proxy, which is the actual fix (#804)', async ({ page }) => {
  await withKey(page, 'tsk_a_key_that_never_gets_to_be_judged');
  // A request that never completes — what a blocked CORS preflight, a dead
  // host, or a production build with no proxy all look like to JS.
  await page.route('**/__tripo/**', (route) => route.abort('failed'));

  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await askForAModel(page);

  const row = page.getByTestId('asset-error-row-Text-to-3D');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('proxy');
  await expect(row).toContainText('offline stub');
  // 🔑 And it is NOT reported as a key problem. Sending someone to re-copy a
  // key that was already correct is the failure this classification exists to
  // prevent.
  await expect(row).not.toContainText('refused the API key');
});

test('no key configured stays silent — that is the documented default (#804)', async ({ page }) => {
  await withKey(page, '');
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await askForAModel(page);

  // The stub generates, as designed, and the banner says nothing: the settings
  // panel already states this is what an unset key does. Announcing an intended
  // state on every generation is the noise that teaches people to ignore the
  // surface that matters.
  await expect(page.getByTestId('asset-error-row-Text-to-3D')).toHaveCount(0);
});
