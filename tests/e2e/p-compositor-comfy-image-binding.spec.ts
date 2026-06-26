// Compositor — the generic image-input affordance for a ComfyUIWorkflow source (§7.1).
// An 'image'-valueKind param (LoadImage.image) renders as a PICKER over the images
// already in the project (+ an upload button), NOT a typed filename and NOT a
// ControlNet special case. Picking a project image stores the binding on the comfy
// node (imageBindings); the decode uploads its bytes + rewrites the input at submit.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, DagNode> };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
}

const API_WORKFLOW = {
  '3': { class_type: 'KSampler', inputs: { seed: 7, steps: 30, cfg: 6.5, model: ['4', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a neon city', clip: ['4', 1] } },
  '10': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
};

test('a LoadImage.image param is a project-image picker; picking one stores the binding', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();

  // Import a workflow carrying a LoadImage (image input) node.
  await page.getByTestId('video-mode-add-layer').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  (await chooserPromise).setFiles({
    name: 'with-image.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(API_WORKFLOW)),
  });
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });

  // Seed an image already in the project (a MediaClip mediaKind:'image' — the same
  // asset a media layer carries). This is what the picker lists.
  await page.evaluate(() => {
    (window as unknown as DagWindow).__basher_dag!.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'media_pose',
          nodeType: 'MediaClip',
          params: {
            name: 'MyPose',
            src: 'media/pose-xyz.png',
            mediaKind: 'image',
            width: 512,
            height: 512,
            srcFps: 30,
            srcFrames: 1,
          },
        },
      ],
      'user',
      'seed project image',
    );
  });

  // Select the layer so the Controls panel populates.
  await page.locator('[data-testid^="layer-bar-"]').first().click();
  const comfyId = await page.evaluate(
    () =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).find(
        (n) => n.type === 'ComfyUIWorkflow',
      )!.id,
  );

  // The image row is a <select> picker (NOT a text input), and it lists the project image.
  const picker = page.getByTestId(`comfy-param-input-${comfyId}-10-image`);
  await expect(picker).toBeVisible();
  expect(await picker.evaluate((el) => el.tagName)).toBe('SELECT');
  await expect(picker.locator('option', { hasText: 'MyPose' })).toHaveCount(1);
  // The upload affordance is present too.
  await expect(page.getByTestId(`comfy-param-upload-${comfyId}-10-image`)).toBeVisible();

  // Pick the project image → the binding is stored on the comfy node as the OPFS path.
  await picker.selectOption('media/pose-xyz.png');
  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const comfy = (window as unknown as DagWindow).__basher_dag!.getState().state.nodes[id];
        return (comfy.params as { imageBindings?: Record<string, string> }).imageBindings?.[
          '10.image'
        ];
      }, comfyId),
    )
    .toBe('media/pose-xyz.png');
});
