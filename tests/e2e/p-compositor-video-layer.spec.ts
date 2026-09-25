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

/** How long a layer gets to paint. Deliberately shorter than the decoder's own 15 s
 *  load + 15 s seek allowance (`VIDEO_OP_TIMEOUT_MS`): a slow decode should FAIL here
 *  and say it was slow, not be absorbed (#1138). */
const PAINT_BUDGET_MS = 8_000;

interface CompositeWatch {
  t0: number;
  /** Every change of the canvas's (planned layer count, completed-draw nonce). */
  samples: { t: number; draws: number; nonce: number }[];
  toasts: { t: number; text: string }[];
}

/**
 * Record what the composite does from now on, so a blank canvas can say why.
 *
 * `data-composite-draws` is the number of layers PLANNED — it reads 1 before any
 * decode starts. `data-composite-nonce` is bumped only after a draw COMPLETES, and
 * the render carrying that bump carries the draws count that draw used (a draw whose
 * plan changed underneath it is cancelled and never bumps). The decode-failure road
 * reports through `console.warn` + an error toast, which auto-dismisses, so both are
 * captured as they happen.
 */
async function watchComposite(page: import('@playwright/test').Page) {
  const warnings: { t: number; text: string }[] = [];
  page.on('console', (msg) => {
    if (msg.text().startsWith('composite: failed to decode'))
      warnings.push({ t: Date.now(), text: msg.text() });
  });
  await page.evaluate(() => {
    const watch = { t0: Date.now(), samples: [], toasts: [] } as unknown as CompositeWatch;
    (window as unknown as { __compositeWatch: CompositeWatch }).__compositeWatch = watch;
    const seenToasts = new Set<string>();
    const record = () => {
      const c = document.querySelector('[data-testid="composite-canvas"]');
      if (c) {
        const draws = Number(c.getAttribute('data-composite-draws'));
        const nonce = Number(c.getAttribute('data-composite-nonce'));
        const last = watch.samples[watch.samples.length - 1];
        if (!last || last.draws !== draws || last.nonce !== nonce)
          watch.samples.push({ t: Date.now(), draws, nonce });
      }
      for (const el of document.querySelectorAll('[data-testid="toast-error"] p')) {
        const text = el.textContent ?? '';
        if (!seenToasts.has(text)) {
          seenToasts.add(text);
          watch.toasts.push({ t: Date.now(), text });
        }
      }
    };
    record();
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-composite-draws', 'data-composite-nonce'],
    });
  });
  return { warnings };
}

/**
 * Wait until a draw of `layers` planned layers has COMPLETED and left real pixels.
 * On timeout, fail with what happened instead of "Timeout 8000ms exceeded":
 * whether such a draw completed and when, and any decode warning / error toast.
 */
async function expectLayersPainted(
  page: import('@playwright/test').Page,
  watch: { warnings: { t: number; text: string }[] },
  layers: number,
) {
  const started = Date.now();
  try {
    await page.waitForFunction(
      (n) => {
        const w = (window as unknown as { __compositeWatch: CompositeWatch }).__compositeWatch;
        const planned = w.samples.findIndex((s) => s.draws === n);
        if (planned < 0) return false;
        const plannedNonce = w.samples[planned].nonce;
        const completed = w.samples
          .slice(planned + 1)
          .some((s) => s.draws === n && s.nonce > plannedNonce);
        if (!completed) return false;
        const c = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
        const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
        for (let i = 4; i < data.length; i += 4)
          if (
            data[i] !== data[0] ||
            data[i + 1] !== data[1] ||
            data[i + 2] !== data[2] ||
            data[i + 3] !== data[3]
          )
            return true;
        return false;
      },
      layers,
      { timeout: PAINT_BUDGET_MS, polling: 100 },
    );
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'TimeoutError') throw err;
    const w = await page.evaluate(
      () => (window as unknown as { __compositeWatch: CompositeWatch }).__compositeWatch,
    );
    const at = (t: number) => `+${t - w.t0} ms`;
    const planned = w.samples.find((s) => s.draws === layers);
    const completed = planned
      ? w.samples.filter((s) => s.draws === layers && s.nonce > planned.nonce)
      : [];
    const failures = [...watch.warnings, ...w.toasts];
    const cause = !planned
      ? `NEVER PLANNED: the composite never planned ${layers} layer(s)`
      : completed.length === 0
        ? `SLOW: no draw of the ${layers}-layer composition completed within ${PAINT_BUDGET_MS} ms`
        : failures.length > 0
          ? `DECODE FAILED: ${completed.length} draw(s) completed but the canvas is uniform, and the decode reported an error`
          : `DREW NOTHING: ${completed.length} draw(s) completed, the canvas is uniform, and no decode error was reported`;
    throw new Error(
      [
        `composite did not paint ${layers} layer(s) — ${cause}`,
        `waited ${Date.now() - started} ms (budget ${PAINT_BUDGET_MS} ms); watch started ${at(started)}`,
        `planned ${layers} layer(s): ${planned ? at(planned.t) : 'never'}`,
        `completed draws of that plan: ${completed.map((s) => `nonce ${s.nonce} @ ${at(s.t)}`).join(', ') || 'none'}`,
        `canvas timeline (draws/nonce): ${w.samples.map((s) => `${s.draws}/${s.nonce}@${at(s.t)}`).join(' ')}`,
        `decode warnings: ${watch.warnings.map((x) => `${at(x.t)} ${x.text}`).join(' | ') || 'none'}`,
        `error toasts: ${w.toasts.map((x) => `${at(x.t)} ${x.text}`).join(' | ') || 'none'}`,
      ].join('\n'),
    );
  }
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
  const watch = await watchComposite(page);
  await addMedia(page, VIDEO, 1);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);

  // Probe populated the MediaClip as a multi-frame VIDEO (distinct from a 1-frame image).
  const [clip] = await mediaClips(page);
  expect(clip.mediaKind).toBe('video');
  expect(Number(clip.srcFrames)).toBeGreaterThan(1);
  expect(Number(clip.width)).toBeGreaterThan(0);
  expect(Number(clip.height)).toBeGreaterThan(0);

  // One layer is PLANNED (this attribute counts the plan, not a finished draw)…
  await expect(page.getByTestId('composite-canvas')).toHaveAttribute('data-composite-draws', '1');
  // …and a draw of that plan COMPLETED with the decoded first frame on the canvas.
  await expectLayersPainted(page, watch, 1);
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
