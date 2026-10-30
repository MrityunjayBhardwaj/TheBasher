// #1734 (6.3) — the composite viewer does no work while the Video space is not shown.
//
// The Video space's slot stays mounted, hidden, when another space is shown (so the
// composition's state survives a switch). The viewer inside it follows the playhead, so in the
// 3D view, playing, it re-read the composition's layers, planned, decoded and drew a frame no
// one could see, every frame: 3% of a playback frame in the frame-pipeline profile.
//
// Read: the viewer's completed-draw counter (`data-composite-nonce`, bumped once per drawn
// frame). Playing for two seconds in the 3D view it must not move; the control — the same two
// seconds in the Video space — must, so the counter is shown to count.

import { test, expect } from './_fixtures';

interface W {
  __basher_time: {
    getState: () => { play: () => void; pause: () => void; setTime: (s: number) => void };
  };
}

async function drawsWhilePlaying(page: import('@playwright/test').Page): Promise<number> {
  const nonce = async () => {
    const v = await page.evaluate(
      () =>
        document
          .querySelector('[data-testid="composite-canvas"]')
          ?.getAttribute('data-composite-nonce') ?? null,
    );
    // An absent canvas would read as zero draws without measuring anything.
    expect(v, 'the viewer is mounted (hidden, not removed)').not.toBeNull();
    return parseInt(v!, 10);
  };
  const before = await nonce();
  await page.evaluate(async () => {
    const t = (window as unknown as W).__basher_time.getState();
    t.setTime(0);
    t.play();
    await new Promise((r) => setTimeout(r, 2000));
    t.pause();
  });
  // Let a draw already in flight land before reading.
  await page.waitForTimeout(200);
  return (await nonce()) - before;
}

test('#1734 the composite viewer draws nothing while the 3D view is shown', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await expect(page.getByTestId('composite-canvas')).toBeVisible();

  // Control: shown, the viewer draws as the playhead moves.
  const shown = await drawsWhilePlaying(page);

  await page.getByTestId('space-switch-view3d').click();
  await expect(page.getByTestId('video-mode-viewer')).toBeHidden();
  const hidden = await drawsWhilePlaying(page);

  console.log(`[p1734] composite draws over 2 s playing: Video space ${shown}, 3D view ${hidden}`);
  expect(shown, 'the counter counts: the shown viewer draws while playing').toBeGreaterThan(10);
  expect(hidden, 'the hidden viewer draws nothing').toBe(0);

  // Back in the Video space it draws again, at the playhead.
  await page.getByTestId('space-switch-video').click();
  await expect(page.getByTestId('composite-canvas')).toBeVisible();
  expect(await drawsWhilePlaying(page)).toBeGreaterThan(10);
});
