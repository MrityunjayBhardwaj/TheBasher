// #1503 — the viewport and the render show different things, as Blender's do. Measured in Blender
// 5.1.1 (Cycles, headless): an object with its eye off still renders, and one with its render
// toggle off does not. Here, on the default project's cube, through the outliner's eye and the
// render the product makes (`renderActiveProjectToDataUrl`, the Render action's road), with the
// render flag set by the outliner's render toggle beside the eye: what the
// viewport draws is read off the live scene, what the render holds off its decoded pixels, and a
// click on where an eye-hidden cube sits must not select it.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
  __basher_mesh_world_position: (id: string) => [number, number, number] | null;
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params?: { viewport?: boolean; render?: boolean } }> };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { primaryNodeId: string | null; clear: () => void };
  };
}

const CUBE = 'n_box';

/** Pixels of the render's centre box that differ from its corner: the cube, when it renders. */
const renderedCubePixels = (page: Page) =>
  page.evaluate(async () => {
    const out = await (window as unknown as W).__basher_render_png!();
    if (!out) return -1;
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
    const bg = ctx.getImageData(2, 2, 1, 1).data;
    // One read of the centre box, sampled every 4th pixel — a read per pixel is what made five
    // full-size renders slow.
    const x0 = Math.floor(out.width * 0.35);
    const y0 = Math.floor(out.height * 0.3);
    const w = Math.floor(out.width * 0.3);
    const h = Math.floor(out.height * 0.4);
    const px = ctx.getImageData(x0, y0, w, h).data;
    let n = 0;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const i = (y * w + x) * 4;
        if (
          Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) >
          24
        )
          n++;
      }
    }
    return n;
  });

const drawnInViewport = (page: Page) =>
  page.evaluate((id) => (window as unknown as W).__basher_mesh_world_position(id) !== null, CUBE);

/** The outliner's render toggle (Blender's "Disable in Renders" camera), the director's door. */
const toggleRender = async (page: Page, want: boolean) => {
  const btn = page.getByTestId(`scene-tree-render-${CUBE}`);
  await btn.click();
  await expect(btn).toHaveAttribute(
    'aria-label',
    want ? 'Disable in renders' : 'Enable in renders',
  );
  expect(
    await page.evaluate(
      (id) => (window as unknown as W).__basher_dag.getState().state.nodes[id].params?.render,
      CUBE,
    ),
  ).toBe(want ? undefined : false);
};

/** Open the default project and return how many render pixels the cube covers there. */
async function ready(page: Page, errors: string[]): Promise<number> {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_render_png && w.__basher_mesh_world_position);
  });
  await expect.poll(() => drawnInViewport(page)).toBe(true);
  const shown = await renderedCubePixels(page);
  expect(shown, 'the premise: the cube renders').toBeGreaterThan(50);
  return shown;
}

const primary = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_selection.getState().primaryNodeId);

test('#1503 — the eye hides the cube from the viewport, not the render, and a click passes it by', async ({
  page,
}) => {
  const errors: string[] = [];
  const shown = await ready(page, errors);

  // A click on the cube selects it — the premise for the pick below.
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.width / 2, y: box.height / 2 };
  await canvas.click({ position: centre });
  await expect.poll(() => primary(page)).toBe(CUBE);
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().clear());

  // The eye: gone from the viewport, still in the render, and a click on it selects nothing.
  await page.getByTestId(`scene-tree-eye-${CUBE}`).click();
  await expect.poll(() => drawnInViewport(page), { message: 'eye off: viewport' }).toBe(false);
  expect(await renderedCubePixels(page), 'eye off: the render still has it').toBeGreaterThan(
    shown * 0.9,
  );
  await canvas.click({ position: centre });
  await page.waitForTimeout(300);
  expect(await primary(page), 'a click lands on what the viewport draws').not.toBe(CUBE);
  expect(errors).toEqual([]);
});

test('#1503 — the render toggle takes the cube out of the render and leaves it in the viewport', async ({
  page,
}) => {
  const errors: string[] = [];
  const shown = await ready(page, errors);

  // Render off: drawn in the viewport, absent from the render.
  await toggleRender(page, false);
  await expect.poll(() => drawnInViewport(page), { message: 'render off: viewport' }).toBe(true);
  expect(await renderedCubePixels(page), 'render off: not in the render').toBeLessThan(shown * 0.1);

  // Back on: in the render again.
  await toggleRender(page, true);
  await expect.poll(() => drawnInViewport(page)).toBe(true);
  expect(await renderedCubePixels(page), 'render back on').toBeGreaterThan(shown * 0.9);
  expect(errors).toEqual([]);
});
