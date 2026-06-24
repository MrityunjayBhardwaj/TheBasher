// Compositor spine 1e — export the composition to a video file. Falsifiable
// against the REAL app: triggering Export ▸ MP4 walks the SAME composite the
// viewer shows over every comp frame and produces a downloadable file with real
// bytes (MP4 where WebCodecs H.264 exists, else the PNG-sequence .zip fallback —
// V38, never silent). Unwire the loop/sink/download and the download never fires.

import { expect, test } from './_fixtures';
import { readFileSync } from 'node:fs';

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

test('Export ▸ MP4 produces a downloadable video file with real bytes', async ({ page }) => {
  await addClip(page, 1);

  await page.getByTestId('video-mode-export').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('video-mode-export-mp4').click(),
  ]);

  const name = download.suggestedFilename();
  expect(name).toMatch(/\.(mp4|zip)$/); // mp4, or the png-sequence fallback

  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = readFileSync(path!);
  // A real encoded video / zip is well over a few KB — a 0-byte or tiny file
  // means the loop produced nothing.
  expect(bytes.byteLength).toBeGreaterThan(2_000);
});

test('Export ▸ PNG Sequence produces a non-trivial .zip', async ({ page }) => {
  await addClip(page, 1);

  await page.getByTestId('video-mode-export').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('video-mode-export-png').click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const path = await download.path();
  const bytes = readFileSync(path!);
  expect(bytes.byteLength).toBeGreaterThan(2_000);
});
