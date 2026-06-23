// ComfyUI epic — Increment 1: REAL control passes (depth / normal / beauty).
//
// The blocker the design doc names: control passes were FAKE (stubEncoder = a
// 1×1 hash PNG). A ControlNet on a hash pixel is meaningless. This OBSERVES
// (Lokayata) the actual decoded pixels of the depth / normal passes rendered
// from the live 3D scene through the production camera — not the DAG, not
// inferred state. Each assertion is FALSIFIABLE: revert the pass material
// override → renderToImage falls back to beauty → the depth-grayscale and
// normal-blue assertions fail (the green cube has g≫r,b on every pixel).
//
// Default project = green cube (#5af07a) lit by one DirectionalLight, framed by
// the PerspectiveCamera at [3,2,3]→origin, RenderOutput 1920×1080.

import { test, expect } from './_fixtures';

type RenderPass = 'beauty' | 'depth' | 'normal';

interface BasherWindow {
  __basher_render_png?: (
    pass?: RenderPass,
  ) => Promise<{ width: number; height: number; dataUrl: string } | null>;
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_render_png),
  );
  await page.waitForTimeout(400); // let the first frame paint
}

/** Render the given pass through the DEV seam, decode the PNG, and report
 *  pixel stats sampled in-page: center, a background corner, and — over a dense
 *  central grid covering the cube — how grayscale it is and how many pixels are
 *  blue-dominant (b ≫ g, impossible for the green beauty cube). */
async function samplePass(page: import('@playwright/test').Page, pass: RenderPass) {
  return page.evaluate(async (passArg: RenderPass) => {
    const out = await (window as unknown as BasherWindow).__basher_render_png!(passArg);
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
      return [p[0], p[1], p[2]] as [number, number, number];
    };
    const center = at(Math.floor(out.width / 2), Math.floor(out.height / 2));
    const corner = at(2, 2);

    // Dense central grid (35%–65% of each axis) — this region is dominated by
    // the cube. Count blue-dominant pixels (b > g + 20: camera-facing faces in a
    // view-space normal pass) and grayscale pixels (|r-g| & |g-b| ≤ 10: a depth
    // ramp). The green beauty cube has g≫b everywhere → blueDominant ≈ 0, and is
    // never grayscale → grayscale ≈ 0.
    const lum = (p: [number, number, number]) => p[0] + p[1] + p[2];
    let blueDominant = 0;
    let grayscale = 0;
    let sampled = 0;
    // Cube-only luminance extent (lum > 150 excludes the dark background) — the
    // spread proves a depth GRADIENT across the cube, not a flat-white silhouette.
    let cubeMin = 999;
    let cubeMax = -1;
    for (let y = Math.floor(out.height * 0.35); y < out.height * 0.65; y += 6) {
      for (let x = Math.floor(out.width * 0.35); x < out.width * 0.65; x += 6) {
        const px = at(x, y);
        const [r, g, b] = px;
        sampled++;
        if (b > g + 20) blueDominant++;
        if (Math.abs(r - g) <= 10 && Math.abs(g - b) <= 10) grayscale++;
        const l = lum(px);
        if (l > 150) {
          if (l < cubeMin) cubeMin = l;
          if (l > cubeMax) cubeMax = l;
        }
      }
    }
    return {
      width: out.width,
      height: out.height,
      center,
      corner,
      blueDominant,
      grayscale,
      sampled,
      cubeLumSpread: cubeMax > 0 ? cubeMax - cubeMin : 0,
      centerLum: lum(center),
      cornerLum: lum(corner),
    };
  }, pass);
}

test.describe('ComfyUI Inc 1 — real control passes', () => {
  test('beauty pass is unchanged — the green cube renders (seam sanity)', async ({ page }) => {
    await waitReady(page);
    const res = (await samplePass(page, 'beauty'))!;
    expect(res).not.toBeNull();
    const [r, g, b] = res.center;
    // Green cube: g dominant. Defeats a broken seam (blank / wrong pass).
    expect(g).toBeGreaterThan(60);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  test('depth pass is a real grayscale ramp — cube nearer (brighter) than the far background', async ({
    page,
  }) => {
    await waitReady(page);
    const res = (await samplePass(page, 'depth'))!;
    const [r, g, b] = res.center;
    // The cube center is grayscale (MeshDepthMaterial writes r=g=b). Revert the
    // pass override → beauty green (g≫r,b) → this fails.
    expect(Math.abs(r - g)).toBeLessThanOrEqual(12);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(12);
    // Near = bright (linear eye-depth, inverted): the cube is much brighter than
    // the cleared far background corner. A flat hash pixel (stubEncoder) or a
    // uniform fill would not show this front-to-back gradient.
    expect(res.centerLum).toBeGreaterThan(res.cornerLum + 60);
    // The central cube region is overwhelmingly grayscale, not green.
    expect(res.grayscale).toBeGreaterThan(res.sampled * 0.5);
    // A real ramp, not a flat-white silhouette: the cube spans a range of
    // luminances (near edge bright, far edge dimmer). Revert the per-content
    // depth normalization (frustum-normalize instead) → uniform white → fails.
    expect(res.cubeLumSpread).toBeGreaterThan(25);
  });

  test('normal pass is a real view-space normal field — blue-dominant camera-facing faces', async ({
    page,
  }) => {
    await waitReady(page);
    const res = (await samplePass(page, 'normal'))!;
    // A view-space normal pass packs (n+1)/2 → camera-facing faces are blue
    // (b high). Many central-grid pixels are blue-dominant. The green beauty cube
    // has g≫b on every pixel → blueDominant ≈ 0. Revert the override → fails.
    expect(res.blueDominant).toBeGreaterThan(50);
  });
});
