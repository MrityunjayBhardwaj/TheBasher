// UX #12 slice 2 — depth of field. The DoF controls author focus distance +
// f-stop on a camera, and the offscreen production render applies real bokeh
// (the same DepthOfFieldEffect the live viewport uses, V37 parity).
//
// The render assertion is falsifiable: reverting the DoF wiring (renderImageAction
// → renderToImage composer path) makes the with-DoF render identical to the
// without-DoF render, and the pixel-difference check fails.

import { test, expect } from './_fixtures';

interface W {
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_dag?: {
    getState: () => {
      dispatchAtomic: (ops: unknown[], src: string, desc: string) => void;
    };
  };
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
}

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  const starter = page.getByText('Starter Scene').first();
  if (await starter.count()) await starter.click().catch(() => {});
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_selection && w.__basher_dag && w.__basher_render_png);
  });
  await page.waitForTimeout(300);
}

/** Count pixels that differ appreciably between two PNG data URLs. Decoding +
 *  the per-pixel diff happen IN-PAGE so only the integer count crosses the
 *  Playwright bridge (returning two 8M-element arrays would time out). */
async function diffCount(
  page: import('@playwright/test').Page,
  urlA: string,
  urlB: string,
): Promise<number> {
  return page.evaluate(
    async ([ua, ub]) => {
      const decode = async (url: string) => {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = url;
        });
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const a = await decode(ua);
      const b = await decode(ub);
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (
          Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) >
          24
        ) {
          changed++;
        }
      }
      return changed;
    },
    [urlA, urlB] as const,
  );
}

test.describe('#12 depth of field', () => {
  test('DoF controls appear when enabled', async ({ page }) => {
    await ready(page);
    await page.evaluate(() =>
      (window as unknown as W).__basher_selection!.getState().select('n_camera'),
    );
    await expect(page.getByTestId('inspector-camera-dof-n_camera')).toBeVisible();
    // Focus + f-stop fields appear only once DoF is on.
    await expect(page.getByTestId('inspector-camera-focus-n_camera')).toHaveCount(0);
    await page.getByTestId('inspector-camera-dof-n_camera').check();
    await expect(page.getByTestId('inspector-camera-focus-n_camera')).toBeVisible();
    await expect(page.getByTestId('inspector-camera-fstop-n_camera')).toBeVisible();
  });

  test('the offscreen render applies bokeh — DoF changes the image (V37 parity)', async ({
    page,
  }) => {
    await ready(page);
    const sharp = await page.evaluate(() => (window as unknown as W).__basher_render_png!());
    expect(sharp).not.toBeNull();

    // Enable DoF with the focus plane in FRONT of the cubes (1.2) at a wide
    // aperture — the cubes (~5 units away) fall well out of focus and blur.
    await page.evaluate(() =>
      (window as unknown as W).__basher_dag!.getState().dispatchAtomic(
        [
          { type: 'setParam', nodeId: 'n_camera', paramPath: 'dofEnabled', value: true },
          { type: 'setParam', nodeId: 'n_camera', paramPath: 'focusDistance', value: 1.2 },
          { type: 'setParam', nodeId: 'n_camera', paramPath: 'fStop', value: 1.2 },
        ],
        'user',
        'enable dof',
      ),
    );
    await page.waitForTimeout(200);
    const blurred = await page.evaluate(() => (window as unknown as W).__basher_render_png!());
    expect(blurred).not.toBeNull();
    expect(blurred!.width).toBe(sharp!.width);

    // DoF blur softens the cube edges → thousands of changed pixels. A no-op
    // (feature reverted) → ~0.
    const changed = await diffCount(page, sharp!.dataUrl, blurred!.dataUrl);
    expect(changed).toBeGreaterThan(1000);
  });
});
