// Compositor inc 2 — the first video EFFECT (Color Correct), the V58 lift to the
// Image socket. Falsifiable against the REAL app: adding a ColorCorrect onto a
// layer (the SAME operatorStack engine geometry modifiers use) splices it on the
// source edge and grades the live composite; the brightness field + mute toggle
// drive / bypass the grade; remove splices the chain closed. Unwire the effect
// apply (compositeDecode.applyEffects) and the brightness assertion drops.

import { expect, test } from './_fixtures';

function meanBrightness(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let s = 0;
    for (let i = 0; i < data.length; i += 4) s += data[i] + data[i + 1] + data[i + 2];
    return s / (data.length / 4);
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
  await expect.poll(() => meanBrightness(page)).toBeGreaterThan(1);
});

test('adding a Color Correct effect grades the composite; mute bypasses; remove restores', async ({
  page,
}) => {
  const base = await meanBrightness(page);

  // Twirl open → the effect stack UI appears.
  await page.locator('[data-testid^="layer-twirl-"]').first().click();
  await page.locator('[data-testid^="layer-add-effect-"]').first().click();
  const effectRow = page.locator('[data-testid^="layer-effect-row-"]').first();
  await expect(effectRow).toBeVisible();

  // Identity (brightness 1) leaves the composite unchanged.
  await expect.poll(() => meanBrightness(page)).toBeCloseTo(base, -1);

  // Darken (brightness 0.3) grades the live composite.
  const bright = page.locator('[data-testid^="layer-effect-bright-"]').first();
  await bright.click();
  await bright.fill('0.3');
  await bright.press('Enter');
  await expect.poll(() => meanBrightness(page)).toBeLessThan(base * 0.6);

  // Mute bypasses the effect → back to the ungraded composite.
  await page.locator('[data-testid^="layer-effect-mute-"]').first().click();
  await expect.poll(() => meanBrightness(page)).toBeGreaterThan(base * 0.9);

  // Unmute → graded again.
  await page.locator('[data-testid^="layer-effect-mute-"]').first().click();
  await expect.poll(() => meanBrightness(page)).toBeLessThan(base * 0.6);

  // Remove splices the chain closed → ungraded composite, row gone.
  await page.locator('[data-testid^="layer-effect-remove-"]').first().click();
  await expect(page.locator('[data-testid^="layer-effect-row-"]')).toHaveCount(0);
  await expect.poll(() => meanBrightness(page)).toBeGreaterThan(base * 0.9);
});
