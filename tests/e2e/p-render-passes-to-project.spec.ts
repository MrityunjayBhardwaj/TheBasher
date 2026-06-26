// Render passes → project images. The "→ Project" button in the Render Result view
// renders beauty/depth/normal at the current frame, writes render_<frame>_<pass>.png
// to OPFS, and registers each as a MediaClip image node — so a video-mode ComfyUI
// layer can reference them in its image inputs (the 3D scene as control rig). Real
// WebGL renders + real OPFS, observed end-to-end.

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
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a city', clip: ['4', 1] } },
  '10': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
};

function imageClips(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes)
      .filter(
        (n) => n.type === 'MediaClip' && (n.params as { mediaKind?: string }).mediaKind === 'image',
      )
      .map((n) => ({
        name: (n.params as { name?: string }).name,
        src: (n.params as { src?: string }).src,
      })),
  );
}

test('“→ Project” saves the control passes as project images, referenceable in a comfy image input', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();

  // Render Result view (2D View) → save passes at the current frame (0).
  await page.getByTestId('space-switch-uv').click();
  await page.getByTestId('twodview-tab-render').click();
  await page.getByTestId('render-result-save-passes').click();

  // The three passes become project images named render_0_{beauty,depth,normal}.
  await expect
    .poll(async () => (await imageClips(page)).map((c) => c.name).sort())
    .toEqual(['render_0_beauty', 'render_0_depth', 'render_0_normal']);
  const clips = await imageClips(page);
  expect(clips.find((c) => c.name === 'render_0_depth')?.src).toBe('renders/render_0_depth.png');

  // In video mode, a ComfyUI layer's image input lists those passes in its picker.
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-add-layer').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  (await chooserPromise).setFiles({
    name: 'wf.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(API_WORKFLOW)),
  });
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
  await page.locator('[data-testid^="layer-bar-"]').first().click();

  const comfyId = await page.evaluate(
    () =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).find(
        (n) => n.type === 'ComfyUIWorkflow',
      )!.id,
  );
  const picker = page.getByTestId(`comfy-param-input-${comfyId}-10-image`);
  await expect(picker.locator('option', { hasText: 'render_0_depth' })).toHaveCount(1);

  // Binding the depth pass stores its OPFS path on the comfy node.
  await picker.selectOption('renders/render_0_depth.png');
  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const comfy = (window as unknown as DagWindow).__basher_dag!.getState().state.nodes[id];
        return (comfy.params as { imageBindings?: Record<string, string> }).imageBindings?.[
          '10.image'
        ];
      }, comfyId),
    )
    .toBe('renders/render_0_depth.png');
});
