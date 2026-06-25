// Compositor inc 3 (spine) — a ComfyUIWorkflow generator LAYER SOURCE. Falsifiable
// against the REAL app: "+ Add Layer ▾ → ComfyUI Workflow" wraps a ComfyUIWorkflow
// node (the polymorphic Image source, V83) as a Layer; the compositor decodes it as
// a deterministic STUB frame (CI-safe, no server) so the generator layer composites
// real, distinct pixels. Real /prompt submit + keyframe-any-param are later slices.
// Unwire the comfy decode branch (compositeDecode.decodeComfyStub) and the composite
// goes black → the pixel assertion drops.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  inputs?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
}

/** Is there a ComfyUIWorkflow node whose `out` feeds some Layer's `source`? */
function comfyWiredToLayer(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const nodes = (window as unknown as DagWindow).__basher_dag?.getState().state.nodes ?? {};
    const comfyIds = Object.values(nodes)
      .filter((n) => n.type === 'ComfyUIWorkflow')
      .map((n) => n.id);
    if (!comfyIds.length) return false;
    return Object.values(nodes).some((n) => {
      if (n.type !== 'Layer') return false;
      const b = n.inputs?.source as { node?: string } | { node?: string }[] | undefined;
      const refs = Array.isArray(b) ? b : b ? [b] : [];
      return refs.some((r) => r.node && comfyIds.includes(r.node));
    });
  });
}

/** Mean of R+G+B over the composite canvas (the live pixels). */
function meanBrightness(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let s = 0;
    for (let i = 0; i < data.length; i += 4) s += data[i] + data[i + 1] + data[i + 2];
    return s / (data.length / 4);
  });
}

/** True iff the composite canvas has more than one distinct pixel (not a flat fill). */
function isNonUniform(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const r0 = data[0];
    const g0 = data[1];
    const b0 = data[2];
    for (let i = 4; i < data.length; i += 4) {
      if (data[i] !== r0 || data[i + 1] !== g0 || data[i + 2] !== b0) return true;
    }
    return false;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
});

test('Add Layer ▸ ComfyUI Workflow wires a ComfyUIWorkflow source and composites a stub frame', async ({
  page,
}) => {
  // The empty comp draws nothing → black canvas.
  expect(await meanBrightness(page)).toBeLessThan(1);

  await page.getByTestId('video-mode-add-layer').click();
  await page.getByTestId('video-mode-add-comfy').click();

  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', {
    timeout: 8_000,
  });

  // The DAG: a ComfyUIWorkflow node feeds a Layer's source edge.
  expect(await comfyWiredToLayer(page)).toBe(true);

  // The composite shows the generator's deterministic stub frame — a distinct,
  // non-black, non-uniform image (the solid colour + the "ComfyUI" label).
  await expect.poll(() => meanBrightness(page)).toBeGreaterThan(1);
  expect(await isNonUniform(page)).toBe(true);
});
