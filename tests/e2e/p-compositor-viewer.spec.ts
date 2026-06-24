// Compositor spine 1d — the live composite viewer. Falsifiable against the REAL
// app: a new comp's viewer is a comp-sized canvas; adding an image layer plans 1
// draw and paints actual (non-uniform) pixels; toggling the layer's visibility
// drops the draw back to 0. Unwire the composite or the decode and an assertion
// drops.

import { expect, test } from './_fixtures';

/** True iff the composite canvas has painted more than one distinct pixel (i.e. an
 *  image drew on top of the flat background). Same-origin OPFS bitmaps → readable. */
function canvasNonUniform(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector(
      '[data-testid="composite-canvas"]',
    ) as HTMLCanvasElement | null;
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 4; i < data.length; i += 4) {
      if (
        data[i] !== data[0] ||
        data[i + 1] !== data[1] ||
        data[i + 2] !== data[2] ||
        data[i + 3] !== data[3]
      ) {
        return true;
      }
    }
    return false;
  });
}

async function addClip(page: import('@playwright/test').Page, n: number) {
  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText(
    `${n} layer${n > 1 ? 's' : ''}`,
    { timeout: 8_000 },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
});

test('the viewer composites an added image layer and tracks visibility', async ({ page }) => {
  const canvas = page.getByTestId('composite-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-composite-draws', '0'); // empty comp

  await addClip(page, 1);
  await expect(canvas).toHaveAttribute('data-composite-draws', '1');

  // The decode is async — wait for a completed draw, then verify real pixels.
  await expect.poll(() => canvasNonUniform(page), { timeout: 8_000 }).toBe(true);

  // Hiding the layer drops it from the composite.
  const visBtn = page.locator('[data-testid^="layer-vis-"]').first();
  await visBtn.click();
  await expect(canvas).toHaveAttribute('data-composite-draws', '0');
});

test('two layers stack into the composite', async ({ page }) => {
  await addClip(page, 1);
  await addClip(page, 2);
  await expect(page.getByTestId('composite-canvas')).toHaveAttribute('data-composite-draws', '2');
});
