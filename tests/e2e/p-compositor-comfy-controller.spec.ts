// The two-node contract (Mode A) — the Controls panel renders the AUTHOR-DECLARED
// basher_controller knobs, not the inferred manifest. A workflow whose KSampler.cfg is
// driven by a `basher_controller` (kind=float, named "Denoise CFG") imports, and the
// Controls panel shows ONE controller row (the declared name + a keyframe diamond) —
// and does NOT infer-expose the other literals (the prompt on node 6). Keying the
// controller mints a KeyframeChannelNumber targeting `controller:<nodeId>` (the H104 +
// kind-dispatch path). Falsifiable: drop the controller-mode dispatch and the legacy
// manifest rows reappear / the controller row vanishes → this fails. No server, no GPU.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
}

// node 10 is a basher_controller (float) WIRED into KSampler.cfg (cfg = ['10', 0]).
const CONTROLLER_WORKFLOW = {
  '3': { class_type: 'KSampler', inputs: { seed: 7, steps: 30, cfg: ['10', 0], model: ['4', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a neon city at dusk', clip: ['4', 1] } },
  '10': {
    class_type: 'basher_controller',
    inputs: { name: 'Denoise CFG', kind: 'float', values_json: '[6.5]', frame_count: 1 },
  },
};

function dagNodes(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).map(
      (n) => ({ id: n.id, type: n.type, params: n.params }),
    ),
  );
}

async function importControllerWorkflow(page: import('@playwright/test').Page) {
  await page.getByTestId('video-mode-add-layer').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'cfg-control.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(CONTROLLER_WORKFLOW)),
  });
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
  await page.locator('[data-testid^="layer-bar-"]').first().click();
  return (await dagNodes(page)).find((n) => n.type === 'ComfyUIWorkflow')!.id;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
});

test('Mode A: the Controls panel shows the declared controller, not the inferred manifest', async ({
  page,
}) => {
  const comfyId = await importControllerWorkflow(page);

  // The declared controller renders as a named, keyframeable row.
  const row = page.getByTestId(`comfy-controller-row-${comfyId}-10`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Denoise CFG');
  await expect(page.getByTestId(`comfy-controller-input-${comfyId}-10`)).toHaveValue('6.5');
  await expect(page.getByTestId(`comfy-controller-diamond-${comfyId}-10`)).toBeVisible();

  // Inference is OFF in Mode A — the prompt (node 6) is NOT re-exposed as a legacy row.
  await expect(page.getByTestId(`comfy-param-input-${comfyId}-6-text`)).toHaveCount(0);
});

test('keying a float controller mints a KeyframeChannelNumber targeting controller:<nodeId>', async ({
  page,
}) => {
  const comfyId = await importControllerWorkflow(page);

  await page.getByTestId(`comfy-controller-diamond-${comfyId}-10`).click();
  await page.waitForTimeout(150);

  const nodes = await dagNodes(page);
  const channel = nodes.find((n) => n.type === 'KeyframeChannelNumber');
  expect(channel).toBeTruthy();
  // the channel targets the ComfyUIWorkflow node at the controller paramPath
  expect((channel!.params as { target?: string }).target).toBe(comfyId);
  expect((channel!.params as { paramPath?: string }).paramPath).toBe('controller:10');
  // a float controller is a Number channel — NOT Text/Color (the kind-dispatch is honest)
  expect(nodes.some((n) => n.type === 'KeyframeChannelText')).toBe(false);
});

// node 12 is an image-kind basher_controller wired into VAEEncode.pixels (cfg=['10',0]
// stays a scalar controller too — both kinds coexist on one workflow).
const MEDIA_WORKFLOW = {
  '3': { class_type: 'KSampler', inputs: { seed: 7, cfg: ['10', 0], latent_image: ['11', 0] } },
  '11': { class_type: 'VAEEncode', inputs: { pixels: ['12', 0] } },
  '10': {
    class_type: 'basher_controller',
    inputs: { name: 'Denoise CFG', kind: 'float', values_json: '[6.5]', frame_count: 1 },
  },
  '12': {
    class_type: 'basher_controller',
    inputs: { name: 'Source Image', kind: 'image', values_json: '[]', frame_count: 1, image: '' },
  },
};

// A tiny valid 8×8 PNG so the upload ingest probes as an image (no server, no GPU).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGM8oaHBgA0wYRUdtBIA4DgBKJ8lCQoAAAAASUVORK5CYII=',
  'base64',
);

test('Mode A: a kind=image controller renders a picker row and binds an uploaded image', async ({
  page,
}) => {
  await page.getByTestId('video-mode-add-layer').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  (await chooserPromise).setFiles({
    name: 'media-control.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(MEDIA_WORKFLOW)),
  });
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
  await page.locator('[data-testid^="layer-bar-"]').first().click();
  const comfyId = (await dagNodes(page)).find((n) => n.type === 'ComfyUIWorkflow')!.id;

  // The scalar controller (10) stays a keyframe row; the image controller (12) is a picker.
  await expect(page.getByTestId(`comfy-controller-diamond-${comfyId}-10`)).toBeVisible();
  const imgRow = page.getByTestId(`comfy-controller-row-${comfyId}-12`);
  await expect(imgRow).toBeVisible();
  await expect(imgRow).toContainText('Source Image');
  // an image controller has NO keyframe diamond (it's a media bind, not a scalar channel)
  await expect(page.getByTestId(`comfy-controller-diamond-${comfyId}-12`)).toHaveCount(0);

  // Upload + bind an image to the controller's own image input (`12.image`).
  const upChooser = page.waitForEvent('filechooser');
  await page.getByTestId(`comfy-controller-upload-${comfyId}-12`).click();
  (await upChooser).setFiles({ name: 'src.png', mimeType: 'image/png', buffer: TINY_PNG });
  await expect
    .poll(async () => {
      const node = (await dagNodes(page)).find((n) => n.id === comfyId)!;
      const b = (node.params as { imageBindings?: Record<string, string> }).imageBindings ?? {};
      return Object.keys(b);
    })
    .toContain('12.image');
});

// node 14 = a video-kind basher_controller wired into VAEEncode.pixels.
const VIDEO_WORKFLOW = {
  '3': { class_type: 'KSampler', inputs: { seed: 7, latent_image: ['11', 0] } },
  '11': { class_type: 'VAEEncode', inputs: { pixels: ['14', 0] } },
  '14': {
    class_type: 'basher_controller',
    inputs: { name: 'Source Video', kind: 'video', values_json: '[]', frame_count: 1, video: '' },
  },
};

// A real VP9-in-MP4 fixture so the upload ingest probes as a video in chromium.
const VIDEO_FIXTURE = 'public/fixtures/video/clip-vp9.mp4';

test('Mode A: a kind=video controller renders a picker row and binds an uploaded video', async ({
  page,
}) => {
  await page.getByTestId('video-mode-add-layer').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  (await chooserPromise).setFiles({
    name: 'video-control.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(VIDEO_WORKFLOW)),
  });
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
  await page.locator('[data-testid^="layer-bar-"]').first().click();
  const comfyId = (await dagNodes(page)).find((n) => n.type === 'ComfyUIWorkflow')!.id;

  const vidRow = page.getByTestId(`comfy-controller-row-${comfyId}-14`);
  await expect(vidRow).toBeVisible();
  await expect(vidRow).toContainText('Source Video');
  // a video controller has NO keyframe diamond (it's a media bind, not a scalar channel)
  await expect(page.getByTestId(`comfy-controller-diamond-${comfyId}-14`)).toHaveCount(0);

  // Upload + bind a video to the controller's own video input (`14.video`).
  const upChooser = page.waitForEvent('filechooser');
  await page.getByTestId(`comfy-controller-upload-${comfyId}-14`).click();
  (await upChooser).setFiles(VIDEO_FIXTURE);
  await expect
    .poll(async () => {
      const node = (await dagNodes(page)).find((n) => n.id === comfyId)!;
      const b = (node.params as { imageBindings?: Record<string, string> }).imageBindings ?? {};
      return Object.keys(b);
    })
    .toContain('14.video');
});
