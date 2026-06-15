// #168 — Render to image: produce & download a final PNG.
//
// These tests OBSERVE the REAL render (Lokayata), not the DAG or inferred
// state: the actual decoded pixels of the offscreen render, and a real
// browser download event. Each behavioral assertion is FALSIFIABLE — reverting
// the feature makes it fail (noted per assertion).
//
// The default project = green cube (#5af07a) lit by one DirectionalLight,
// framed by the PerspectiveCamera at [3,2,3]→origin, RenderOutput 1920×1080.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_render_png),
  );
  await page.waitForTimeout(400); // let the first frame paint
}

/** Render via the DEV seam and decode the PNG, sampling pixels in-page. */
async function renderAndSample(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const out = await (window as unknown as BasherWindow).__basher_render_png!();
    if (!out) return null;
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = out.dataUrl;
    });
    const cv = document.createElement('canvas');
    cv.width = out.width;
    cv.height = out.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const at = (x: number, y: number) => {
      const p = ctx.getImageData(x, y, 1, 1).data;
      return [p[0], p[1], p[2], p[3]] as [number, number, number, number];
    };
    // The background reference is the actual corner pixel, NOT a hardcoded
    // colour — the dark redesign moved the ambient stage from ~[10,10,10] to
    // [26,27,32], so a literal made every pixel read "non-bg" (the H27/V39
    // re-validation trap). Chrome leak = DEVIATION from the true background.
    const bg = at(2, 2);
    const isNonBg = (x: number, y: number) => {
      const [r, g, b] = at(x, y);
      return Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24;
    };
    // Dense sample of the bottom-LEFT quadrant — cube-free, but exactly where
    // the floor grid is densest. Background-only (0) when chrome is excluded;
    // the grid alone puts ~220 non-bg pixels here when it leaks. This is the
    // falsifiable chrome signal (measured: 0 excluded vs 221 leaked).
    let chromeRegionNonBg = 0;
    for (let y = Math.floor(out.height * 0.55); y < out.height * 0.98; y += 4) {
      for (let x = Math.floor(out.width * 0.02); x < out.width * 0.3; x += 4) {
        if (isNonBg(x, y)) chromeRegionNonBg++;
      }
    }
    return {
      width: out.width,
      height: out.height,
      center: at(Math.floor(out.width / 2), Math.floor(out.height / 2)),
      corner: at(2, 2),
      chromeRegionNonBg,
    };
  });
}

test.describe('#168 render to image', () => {
  test('renders at the explicit RenderOutput resolution, not the viewport size', async ({
    page,
  }) => {
    await waitReady(page);
    const canvasSize = await page.evaluate(() => {
      const cv = document.querySelector(
        '[data-testid="viewport-canvas"] canvas',
      ) as HTMLCanvasElement;
      return { w: cv.width, h: cv.height };
    });
    const res = (await renderAndSample(page))!;
    expect(res).not.toBeNull();
    // 1920×1080 from RenderOutput.width/height — NOT the viewport canvas size.
    // Revert Wave A (explicit resolution) → render matches the viewport → fails.
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
    expect(res.width).not.toBe(canvasSize.w);
  });

  test('the render is NOT blank — the cube is visible (defeats the H68 trap)', async ({ page }) => {
    await waitReady(page);
    const res = (await renderAndSample(page))!;
    // Center pixel is the green cube, not the #0a0a0a background and not blank.
    // Revert Wave B (offscreen render) → toDataURL of preserveDrawingBuffer:false
    // canvas → uniform blank → center fails the green check.
    const [r, g, b, a] = res.center;
    expect(g).toBeGreaterThan(60); // green channel dominant
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(a).toBe(255);
    // Background corner is the scene bg (#0a0a0a ≈ 10,10,10), proving a real
    // render with a real background, not a uniform fill.
    expect(res.corner[0]).toBeLessThan(40);
    expect(res.corner[1]).toBeLessThan(40);
  });

  test('editor chrome is excluded — only DAG content renders', async ({ page }) => {
    await waitReady(page);
    const res = (await renderAndSample(page))!;
    // The cube-free bottom-left quadrant is pure background when chrome is
    // excluded. Revert the chrome marks (or the renderToImage hide-pass) → the
    // floor grid leaks ~221 non-bg pixels here → this fails. (Physically
    // falsified during Wave D: 0 excluded vs 221 leaked.)
    expect(res.chromeRegionNonBg).toBeLessThan(20);
  });

  test('File ▸ Render Image downloads a PNG named for the resolution', async ({ page }) => {
    await waitReady(page);
    // The render affordance lives in the File menu (the UX overhaul retired the
    // top-toolbar button — render is a File action like Save/Export).
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('menu-file-button').click();
    await page.getByTestId('menu-file-render-image').click();
    const download = await downloadPromise;
    // Revert the download affordance → no download event → times out.
    expect(download.suggestedFilename()).toMatch(/-1920x1080\.png$/);
  });
});
