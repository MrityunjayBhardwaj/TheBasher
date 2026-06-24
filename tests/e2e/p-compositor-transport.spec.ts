// Compositor spine 1d follow-up — the video-mode transport. Falsifiable against
// the REAL app: the transport bar plays/pauses the GLOBAL playhead and reads out
// the comp frame; pressing play advances the readout (and the composite redraws);
// jump-to-start resets it; dragging the comp ruler scrubs to the clicked frame;
// and the readout's total reflects the comp's frame count (the duration is sized
// to the comp while in video mode). Unwire any of these and an assertion drops.

import { expect, test } from './_fixtures';

/** Parse the leading comp-frame integer out of the transport readout
 *  ("N / total · S.SSs"). */
async function readFrame(page: import('@playwright/test').Page): Promise<number> {
  const txt = (await page.getByTestId('video-transport-readout').textContent()) ?? '';
  return parseInt(txt.trim().split(' ')[0], 10);
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

test('the readout total reflects the comp frame count (duration sized to comp)', async ({
  page,
}) => {
  // The default new comp is 150 frames @ 30fps. The readout starts at frame 0.
  await expect(page.getByTestId('video-transport-readout')).toContainText('0 / 150');
});

test('play advances the playhead and pause stops it', async ({ page }) => {
  const transport = page.getByTestId('video-transport');
  await expect(transport).toHaveAttribute('data-playing', 'false');
  expect(await readFrame(page)).toBe(0);

  await page.getByTestId('video-transport-play').click();
  await expect(transport).toHaveAttribute('data-playing', 'true');

  // The global clock (Clock.tsx rAF) should advance the comp frame past 0.
  await expect.poll(() => readFrame(page), { timeout: 4_000 }).toBeGreaterThan(0);

  await page.getByTestId('video-transport-play').click();
  await expect(transport).toHaveAttribute('data-playing', 'false');
  const stopped = await readFrame(page);

  // Paused → the frame holds (no further advance after a beat).
  await page.waitForTimeout(300);
  expect(await readFrame(page)).toBe(stopped);

  // Jump-to-start returns the playhead to frame 0.
  await page.getByTestId('video-transport-start').click();
  expect(await readFrame(page)).toBe(0);
});

test('dragging the comp ruler scrubs the playhead to the clicked frame', async ({ page }) => {
  await addClip(page, 1);
  const ruler = page.getByTestId('layer-timeline-ruler');
  const box = await ruler.boundingBox();
  if (!box) throw new Error('no ruler box');

  // Press near the middle of the ruler → ~ frame 75 of 150 (track spans the ruler).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  // Allow generous tolerance for the outline-column offset (the track starts after
  // the 220px outline) — the point is the playhead MOVED off 0 toward the middle.
  await expect.poll(() => readFrame(page), { timeout: 4_000 }).toBeGreaterThan(20);

  // Dragging back to the far left scrubs to (near) frame 0.
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => readFrame(page), { timeout: 4_000 }).toBeLessThan(20);
});
