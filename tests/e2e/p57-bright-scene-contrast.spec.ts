// P57 — bright-scene contrast gate (Lokayata proof for D-W8-1).
//
// THE LIE THIS TEST KILLS
// =======================
// The contrast-audit matrix (src/a11y/contrastMatrix.test.ts) composites
// every chrome surface against the worst-case FIXED page bg `#0a0a0a`
// (D-W8-1). R8 (FloatingViewportToolbar) and ModeBadge are the only two
// surfaces that sit over the GL canvas — a VARIABLE-color backdrop. For
// those two, the matrix's PASS was an INFERENCE: it assumed the backdrop
// is `#0a0a0a` (true for the default dark scene, FALSE for a bright HDRI
// / matcap). Issue #57 demanded the gap be closed by OBSERVATION on a
// real bright scene, not more math.
//
// WHAT THIS TEST OBSERVES
// =======================
// Drives the REAL scene background bright via the DEV-only seam
// `window.__basher_setSceneBackground` (src/viewport/SceneBgTestSeam.tsx),
// then screenshots the actually-composited R8 + ModeBadge overlays and
// pixel-samples them. The decomposition that makes this rigorous:
//
//   - The SURFACE (`bg-2/90` composited over the GL canvas) is the ONLY
//     scene-dependent value — the exact thing #57 doubts. We MEASURE it
//     from real pixels (the modal color of the overlay box; the bg fill
//     dominates the pixel population in a sparse-text toolbar).
//   - The GLYPH foreground (`text-fg-dim` etc.) is fully OPAQUE, so it
//     renders at its token color regardless of scene. We read it exactly
//     via getComputedStyle on a real idle button — observed, not assumed.
//   - Contrast = contrastRatio(observedFg, measuredSurface), via the SAME
//     wcag.ts helper the matrix uses (zero formula drift).
//
// FALSIFICATION (guards against a vacuous pass)
// =============================================
//   - The measured surface under a WHITE scene must be meaningfully
//     LIGHTER than under the DARK scene — proves the seam actually drove
//     the canvas bright and we observed the variable bg (not a no-op that
//     would make every assertion pass trivially).
//   - The overlay box must contain real light glyph pixels at ~the fg
//     luminance — proves the text paints at full strength over the bright
//     surface, i.e. is not blended away.
//
// REF: src/viewport/SceneBgTestSeam.tsx; src/a11y/contrastMatrix.test.ts
//      (D-W8-1 worst-case-white rows); docs/UI-SPEC.md §8.4.1; issue #57.

import { contrastRatio, type RGB } from '../../src/a11y/wcag';
import { expect, test } from './_fixtures';

interface SeamWindow {
  __basher_setSceneBackground?: (hex: string) => void;
}

/** Drive the real GL canvas to `hex` and let it repaint. */
async function setSceneBg(page: import('@playwright/test').Page, hex: string): Promise<void> {
  await page.evaluate((h) => {
    const w = window as unknown as SeamWindow;
    if (!w.__basher_setSceneBackground) throw new Error('#57 seam missing');
    w.__basher_setSceneBackground(h);
  }, hex);
  // Two rAFs: one to flush the imperative scene.background set into a
  // render, one for the browser to composite the DOM overlay over it.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** Screenshot a testid's box, decode it IN-PAGE (browser decodes the PNG —
 *  no external decoder dep), and return the measured surface RGB + a
 *  representative bright-glyph RGB + the pixel population stats. */
async function sampleOverlay(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<{ surface: RGB; brightGlyph: RGB; surfaceLum: number; glyphLum: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no boundingBox for ${testId}`);
  const buf = await page.screenshot({
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;

  return page.evaluate(async (url) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('decode failed'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);

    const lum = (r: number, g: number, b: number): number => {
      const lin = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };

    // SURFACE = modal color (the bg fill dominates a sparse-text toolbar).
    // Quantize to 5-bit buckets, find the most-populous, average its members.
    const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
    // GLYPH = brightest GRAYISH bucket with a real population (excludes the
    // green accent text of the active tool + AA-edge singletons).
    const grayLum: { l: number; r: number; g: number; b: number }[] = [];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const e = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      e.r += r;
      e.g += g;
      e.b += b;
      e.n += 1;
      buckets.set(key, e);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma < 24) grayLum.push({ l: lum(r, g, b), r, g, b });
    }
    let top = { r: 0, g: 0, b: 0, n: -1 };
    for (const e of buckets.values()) if (e.n > top.n) top = e;
    const surface = { r: top.r / top.n, g: top.g / top.n, b: top.b / top.n };

    // Brightest grayish pixel at the ~99th percentile (the glyph core,
    // robust to single AA outliers).
    grayLum.sort((a, b) => a.l - b.l);
    const pick = grayLum[Math.floor(grayLum.length * 0.99)] ?? grayLum[grayLum.length - 1];
    const brightGlyph = { r: pick.r, g: pick.g, b: pick.b };

    return {
      surface,
      brightGlyph,
      surfaceLum: lum(surface.r, surface.g, surface.b),
      glyphLum: lum(pick.r, pick.g, pick.b),
    };
  }, dataUrl);
}

/** Read the exact rendered foreground color (opaque token) of an element. */
async function computedColor(page: import('@playwright/test').Page, testId: string): Promise<RGB> {
  const css = await page.getByTestId(testId).evaluate((el) => getComputedStyle(el).color);
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`unparseable color "${css}"`);
  const [r, g, b] = m[1].split(',').map((s) => parseFloat(s.trim()));
  return { r, g, b };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();
  await expect(page.getByTestId('mode-badge')).toBeVisible();
  // The DEV-only seam must be installed (proves we're in a dev build where
  // the test can drive the scene bright).
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as unknown as SeamWindow).__basher_setSceneBackground),
    )
    .toBe('function');
});

// AA small-text threshold. ModeBadge text + R8 idle glyphs are <18px.
const AA = 4.5;

test('P57#1 R8 idle glyphs hold WCAG-AA over a bright GL canvas (real pixels)', async ({
  page,
}) => {
  // Observed fg: an IDLE tool button (Move) renders text-fg-dim — the exact
  // worst-case glyph #57 names. (Select is active by default → accent;
  // Move/Rotate/Scale are idle → fg-dim.)
  const fg = await computedColor(page, 'floating-toolbar-move');

  // Baseline (dark scene) — what the matrix already audits.
  await setSceneBg(page, '#0a0a0a');
  const dark = await sampleOverlay(page, 'floating-viewport-toolbar');

  // Worst case: a full-white blowout behind the overlay.
  await setSceneBg(page, '#ffffff');
  const bright = await sampleOverlay(page, 'floating-viewport-toolbar');

  // FALSIFICATION: the white scene must measurably lighten the surface, or
  // the seam did nothing and every contrast assertion below is vacuous.
  expect(
    bright.surfaceLum,
    `white scene must lighten R8 surface vs dark (dark=${dark.surfaceLum.toFixed(4)} bright=${bright.surfaceLum.toFixed(4)}) — else the seam is a no-op and the test is vacuous`,
  ).toBeGreaterThan(dark.surfaceLum * 1.3);

  // FALSIFICATION: real light glyphs must paint over the bright surface
  // (not blended away) — glyph luminance well above the surface.
  expect(bright.glyphLum).toBeGreaterThan(bright.surfaceLum * 3);

  // THE PROOF: observed-fg vs measured-bright-surface clears AA.
  // Observed 2026-06-02: surface measured #2d2d2d over #ffffff → 5.47:1,
  // matching the wcag.ts formula prediction (5.44:1) to within AA noise.
  const ratio = contrastRatio(fg, bright.surface);
  expect(
    ratio,
    `R8 fg-dim idle glyph over WHITE scene = ${ratio.toFixed(2)}:1 (surface measured ${JSON.stringify(bright.surface)})`,
  ).toBeGreaterThanOrEqual(AA);
});

test('P57#2 ModeBadge text holds WCAG-AA over a bright GL canvas (real pixels)', async ({
  page,
}) => {
  // ModeBadge inner span carries text-fg-dim (the audited token).
  const fg = await computedColor(page, 'mode-badge');

  await setSceneBg(page, '#0a0a0a');
  const dark = await sampleOverlay(page, 'mode-badge');
  await setSceneBg(page, '#ffffff');
  const bright = await sampleOverlay(page, 'mode-badge');

  expect(
    bright.surfaceLum,
    `white scene must lighten ModeBadge surface (dark=${dark.surfaceLum.toFixed(4)} bright=${bright.surfaceLum.toFixed(4)})`,
  ).toBeGreaterThan(dark.surfaceLum * 1.3);
  expect(bright.glyphLum).toBeGreaterThan(bright.surfaceLum * 3);

  const ratio = contrastRatio(fg, bright.surface);
  expect(
    ratio,
    `ModeBadge fg-dim over WHITE scene = ${ratio.toFixed(2)}:1 (surface ${JSON.stringify(bright.surface)})`,
  ).toBeGreaterThanOrEqual(AA);
});

test('P57#3 mid-luminance scene (#808080 matcap) also clears AA — R8 + ModeBadge', async ({
  page,
}) => {
  await setSceneBg(page, '#808080');
  const r8Fg = await computedColor(page, 'floating-toolbar-move');
  const r8 = await sampleOverlay(page, 'floating-viewport-toolbar');
  const badgeFg = await computedColor(page, 'mode-badge');
  const badge = await sampleOverlay(page, 'mode-badge');

  expect(contrastRatio(r8Fg, r8.surface)).toBeGreaterThanOrEqual(AA);
  expect(contrastRatio(badgeFg, badge.surface)).toBeGreaterThanOrEqual(AA);
});
