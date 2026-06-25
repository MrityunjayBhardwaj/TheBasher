// Compositor spine 1b.2 — VIDEO mode end-to-end with IMAGE and MP4 VIDEO layers.
//
// Falsifiable against the REAL browser path (no stub seam): an image PNG and an MP4
// video are imported as Composition layers, decoded, and composited to actual pixels;
// scrubbing the playhead over a video layer changes the composited frame (proving the
// HTMLVideoElement seek-decode is frame-accurate across the timeline, slice 1b.2).
//
// FIXTURE CODEC NOTE: the video fixture is VP9-in-MP4 (a genuine .mp4) because
// Playwright's bundled Chromium lacks proprietary H.264 — VP9 is royalty-free and
// decodes in every Chromium incl. CI. The decode path itself is codec-agnostic
// (HTMLVideoElement uses whatever the browser ships), so real H.264 mp4s work in
// real Chrome/Safari. The fixture content (ffmpeg testsrc2) changes every frame, so
// two distinct source frames have distinct pixels.
//
// Unwire video decode (WebCodecsMediaDecode → throw) or the ingest, and the video
// MediaClip never lands / the canvas stays blank → these assertions drop.

import { expect, test } from './_fixtures';

const IMAGE = 'public/fixtures/multifile/flat/texture.png';
const VIDEO = 'public/fixtures/video/clip-vp9.mp4';

interface DagWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params?: Record<string, unknown> }> };
    };
  };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
}

function mediaClips(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const nodes = w.__basher_dag?.getState().state.nodes ?? {};
    return Object.values(nodes)
      .filter((n) => n.type === 'MediaClip')
      .map((n) => n.params ?? {});
  });
}

/** A cheap checksum over the composite canvas pixels (same shape as the comfy spec). */
function pixelChecksum(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let h = 0;
    for (let i = 0; i < data.length; i += 17) h = (h * 31 + data[i]) >>> 0;
    return h;
  });
}

/** True iff the composite canvas painted more than one distinct pixel. */
function canvasNonUniform(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector(
      '[data-testid="composite-canvas"]',
    ) as HTMLCanvasElement | null;
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 4; i < data.length; i += 4)
      if (
        data[i] !== data[0] ||
        data[i + 1] !== data[1] ||
        data[i + 2] !== data[2] ||
        data[i + 3] !== data[3]
      )
        return true;
    return false;
  });
}

async function addMedia(page: import('@playwright/test').Page, file: string, expectCount: number) {
  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles(file);
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText(
    `${expectCount} layer${expectCount > 1 ? 's' : ''}`,
    { timeout: 8_000 },
  );
}

async function seek(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as DagWindow).__basher_time?.getState().setTime(s);
  }, seconds);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
});

test('an image layer composites real pixels', async ({ page }) => {
  const canvas = page.getByTestId('composite-canvas');
  await expect(canvas).toHaveAttribute('data-composite-draws', '0');

  await addMedia(page, IMAGE, 1);
  await expect(canvas).toHaveAttribute('data-composite-draws', '1');
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  await expect.poll(() => canvasNonUniform(page), { timeout: 8_000 }).toBe(true);
});

test('an MP4 video ingests as a video MediaClip and composites real pixels', async ({ page }) => {
  await addMedia(page, VIDEO, 1);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);

  // Probe populated the MediaClip as a multi-frame VIDEO (distinct from a 1-frame image).
  const [clip] = await mediaClips(page);
  expect(clip.mediaKind).toBe('video');
  expect(Number(clip.srcFrames)).toBeGreaterThan(1);
  expect(Number(clip.width)).toBeGreaterThan(0);
  expect(Number(clip.height)).toBeGreaterThan(0);

  // The first frame actually decoded onto the composite.
  await expect(page.getByTestId('composite-canvas')).toHaveAttribute('data-composite-draws', '1');
  await expect.poll(() => canvasNonUniform(page), { timeout: 8_000 }).toBe(true);
});

test('scrubbing a video layer changes the composited frame', async ({ page }) => {
  await addMedia(page, VIDEO, 1);
  await expect.poll(() => canvasNonUniform(page), { timeout: 8_000 }).toBe(true);

  // Frame at t=0s vs t=1.0s — both inside the 2s clip (startFrame 0), so the layer is
  // visible at both; testsrc2 changes every frame → the decoded frame differs.
  await seek(page, 0);
  await page.waitForTimeout(400);
  const atStart = await pixelChecksum(page);

  await seek(page, 1.0);
  await expect.poll(() => pixelChecksum(page), { timeout: 8_000 }).not.toBe(atStart);
});

test('an image and an MP4 video stack as two layers in one composition', async ({ page }) => {
  await addMedia(page, IMAGE, 1);
  await addMedia(page, VIDEO, 2);
  await expect(page.getByTestId('composite-canvas')).toHaveAttribute('data-composite-draws', '2');
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  await expect.poll(() => canvasNonUniform(page), { timeout: 8_000 }).toBe(true);
});
