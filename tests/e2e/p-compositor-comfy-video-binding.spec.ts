// Compositor — the generic VIDEO-input affordance for a ComfyUIWorkflow source (the
// Mode-B mirror of the kind=video controller, docs/COMFYUI-BASHER-NODES.md). A vanilla
// workflow with a LoadVideo node gets a bindable video input: the 'video'-valueKind
// param (LoadVideo.file) renders as a PICKER over the videos already in the project
// (+ an upload button), NOT a typed filename. Picking a project video stores the
// binding on the comfy node (imageBindings keyed `<nodeId>.file`); the decode/compile
// uploads its bytes (keeping the real container ext) + rewrites `inputs.file` at submit.

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

// A vanilla img2img-style workflow: LoadVideo.file → VAEEncode → KSampler (no
// basher_* nodes, so the Controls panel falls back to the Mode-B inferred manifest).
const API_WORKFLOW = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 7,
      steps: 30,
      cfg: 6.5,
      denoise: 0.6,
      model: ['4', 0],
      latent_image: ['11', 0],
    },
  },
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
  },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a neon city', clip: ['4', 1] } },
  '10': { class_type: 'LoadVideo', inputs: { file: 'placeholder.mp4' } },
  '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
};

test('a LoadVideo.file param is a project-video picker; picking one stores the binding', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();

  // Import a workflow carrying a LoadVideo (video input) node.
  await page.getByTestId('video-mode-add-layer').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  (await chooserPromise).setFiles({
    name: 'with-video.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(API_WORKFLOW)),
  });
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });

  // Seed a video already in the project (a MediaClip mediaKind:'video' — the same asset
  // a video layer carries). This is what the video picker lists.
  await page.evaluate(() => {
    (window as unknown as DagWindow).__basher_dag!.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'media_clip',
          nodeType: 'MediaClip',
          params: {
            name: 'MyClip',
            src: 'media/orbit.mp4',
            mediaKind: 'video',
            width: 512,
            height: 512,
            srcFps: 30,
            srcFrames: 6,
          },
        },
      ],
      'user',
      'seed project video',
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

  // The video row is a <select> picker (NOT a text input), and it lists the project video.
  const picker = page.getByTestId(`comfy-param-input-${comfyId}-10-file`);
  await expect(picker).toBeVisible();
  expect(await picker.evaluate((el) => el.tagName)).toBe('SELECT');
  await expect(picker.locator('option', { hasText: 'MyClip' })).toHaveCount(1);
  // The upload affordance is present too.
  await expect(page.getByTestId(`comfy-param-upload-${comfyId}-10-file`)).toBeVisible();

  // Pick the project video → the binding is stored on the comfy node as the OPFS path,
  // keyed `<nodeId>.file` (so applyComfyImageBindings rewrites inputs.file at submit).
  await picker.selectOption('media/orbit.mp4');
  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const comfy = (window as unknown as DagWindow).__basher_dag!.getState().state.nodes[id];
        return (comfy.params as { imageBindings?: Record<string, string> }).imageBindings?.[
          '10.file'
        ];
      }, comfyId),
    )
    .toBe('media/orbit.mp4');
});

// A video param is a MEDIA bind handled out-of-band by applyComfyImageBindings — NOT an
// in-graph schedule. So a Mode-B render of a workflow with a LoadVideo node must NOT
// demote the VIDEO param ('unsupported-kind' → a spurious "preview-only" warn toast): the
// bake skips constant media params (image AND video). The demotion depends only on the
// param existing, so a stub-forced render exercises it deterministically — no GPU needed.
// (A constant string prompt demoting is SEPARATE pre-existing Mode-B behavior — not
// asserted here; this guards only the video-param fix.)
test('Mode-B render of a LoadVideo workflow does not demote the video param', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __basher_useStubComfy?: () => void }).__basher_useStubComfy?.();
  });
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-add-layer').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('video-mode-add-comfy-json').click();
  (await chooser).setFiles({
    name: 'with-video.json',
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

  // Accumulate every warn-toast text as it appears (toasts auto-dismiss), so a transient
  // demotion toast during the render can't slip past a single point-in-time assertion.
  await page.evaluate(() => {
    (window as unknown as { __warnToasts?: string[] }).__warnToasts = [];
    const seen = (window as unknown as { __warnToasts: string[] }).__warnToasts;
    const scan = () =>
      document.querySelectorAll('[data-testid="toast-warn"]').forEach((el) => {
        const t = el.textContent ?? '';
        if (t && !seen.includes(t)) seen.push(t);
      });
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    scan();
  });

  await page.getByTestId(`comfy-render-clip-${comfyId}`).click();
  // The render completes (a stub MediaClip lands) — proves the path ran to the end.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            Object.values(
              (window as unknown as DagWindow).__basher_dag!.getState().state.nodes,
            ).filter((n) => n.type === 'MediaClip').length,
          [],
        ),
      { timeout: 20000 },
    )
    .toBe(1);

  const warns = await page.evaluate(
    () => (window as unknown as { __warnToasts?: string[] }).__warnToasts ?? [],
  );
  // No demotion toast names the LoadVideo param (node 10, input `file`). Without the
  // constant-video skip in bakeComfyBatchedTracks this would read "…preview-only…: 10.file".
  expect(warns.find((t) => /preview-only/i.test(t) && t.includes('10.file'))).toBeUndefined();
});
