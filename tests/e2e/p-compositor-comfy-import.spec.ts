// Compositor Inc 3 — load a ComfyUI workflow JSON as a layer. The Add Layer ▸
// "ComfyUI Workflow (from JSON…)" affordance opens a file picker; a picked API-format
// workflow is parsed (parseComfyWorkflowJson) and added as a ComfyUIWorkflow layer
// whose graph IS the imported json — so the Controls panel renders the imported
// manifest. A UI-format ("Save") export is rejected with an actionable banner, never a
// silent empty layer. Driven through the real picker via Playwright's filechooser.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
}

const API_WORKFLOW = {
  '3': { class_type: 'KSampler', inputs: { seed: 7, steps: 30, cfg: 6.5, model: ['4', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a neon city at dusk', clip: ['4', 1] } },
  '10': { class_type: 'LoadImage', inputs: { image: 'pose.png' } },
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
});

test('Add Layer ▸ ComfyUI Workflow (from JSON) imports an API-format workflow', async ({
  page,
}) => {
  await page.getByTestId('video-mode-add-layer').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'neon-city.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(API_WORKFLOW)),
  });

  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });

  // The new ComfyUIWorkflow node carries the IMPORTED graph (its node ids), and the
  // layer is named from the filename.
  const imported = await page.evaluate(() => {
    const nodes = (window as unknown as DagWindow).__basher_dag!.getState().state.nodes;
    const comfy = Object.values(nodes).find((n) => n.type === 'ComfyUIWorkflow');
    const layer = Object.values(nodes).find((n) => n.type === 'Layer');
    const graph = comfy?.params?.graph as
      | { apiJson?: Record<string, { class_type?: string }>; meta?: { name?: string } }
      | undefined;
    return {
      hasNode10: !!graph?.apiJson?.['10'],
      node10Class: graph?.apiJson?.['10']?.class_type,
      metaName: graph?.meta?.name,
      layerName: (layer?.params as { name?: string } | undefined)?.name,
    };
  });
  expect(imported.hasNode10).toBe(true);
  expect(imported.node10Class).toBe('LoadImage');
  expect(imported.metaName).toBe('neon-city');
  expect(imported.layerName).toBe('neon-city');

  // The Controls panel renders the imported manifest: select the layer, see the prompt
  // row (node 6) AND the imported LoadImage row (node 10, an image param).
  await page.locator('[data-testid^="layer-bar-"]').first().click();
  const comfyId = await page.evaluate(
    () =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).find(
        (n) => n.type === 'ComfyUIWorkflow',
      )!.id,
  );
  await expect(page.getByTestId(`comfy-param-input-${comfyId}-6-text`)).toBeVisible();
  await expect(page.getByTestId(`comfy-param-input-${comfyId}-10-image`)).toBeVisible();
});

test('a UI-format ("Save") export is rejected, no layer created', async ({ page }) => {
  await page.getByTestId('video-mode-add-layer').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'ui-export.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ nodes: [{ id: 1, type: 'KSampler' }], links: [] })),
  });

  // An actionable error TOAST appears (app-root, visible in VIDEO mode — not the
  // view3d-slot banner the compositor covers); no ComfyUIWorkflow layer is created.
  const toast = page.getByTestId('toast-error');
  await expect(toast).toBeVisible({ timeout: 8000 });
  await expect(toast).toContainText('API Format');
  const comfyCount = await page.evaluate(
    () =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).filter(
        (n) => n.type === 'ComfyUIWorkflow',
      ).length,
  );
  expect(comfyCount).toBe(0);
});
