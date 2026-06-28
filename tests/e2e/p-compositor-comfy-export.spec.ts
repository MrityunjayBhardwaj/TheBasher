// Two-node contract — the OUTPUT half. A workflow that declares basher_export sinks
// collects EACH export's frames into its OWN named project MediaClip (author-declared
// collection), instead of merging every output node into one clip. Stub-forced so this
// is a CI gate independent of a locally-running ComfyUI (the stub groups frames by the
// declared export node ids → exercises the framesByNode routing). No server, no GPU.

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

// Two declared export sinks ("Beauty" node 20, "Depth" node 5) off one VAEDecode.
const WF = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '3': { class_type: 'KSampler', inputs: { seed: 1, cfg: 7, latent_image: ['5l', 0] } },
  '5l': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '20': { class_type: 'basher_export', inputs: { name: 'Beauty', images: ['8', 0] } },
  '5': { class_type: 'basher_export', inputs: { name: 'Depth', images: ['8', 0] } },
};

function nodesOfType(page: import('@playwright/test').Page, type: string) {
  return page.evaluate(
    (t) =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes)
        .filter((n) => n.type === t)
        .map((n) => ({ id: n.id, params: n.params })),
    type,
  );
}

test.beforeEach(async ({ page }) => {
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
    name: 'exports.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(WF)),
  });
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
  await page.locator('[data-testid^="layer-bar-"]').first().click();
});

test('basher_export: each declared sink collects into its own named MediaClip', async ({
  page,
}) => {
  const comfyId = (await nodesOfType(page, 'ComfyUIWorkflow'))[0].id;

  // No MediaClip yet (the comfy SOURCE is a generator, not a media node).
  expect(await nodesOfType(page, 'MediaClip')).toHaveLength(0);

  await page.getByTestId(`comfy-render-clip-${comfyId}`).click();

  // TWO video MediaClips appear — one per declared export, named for it.
  await expect
    .poll(async () => (await nodesOfType(page, 'MediaClip')).length, { timeout: 20000 })
    .toBe(2);
  const clips = await nodesOfType(page, 'MediaClip');
  const names = clips.map((c) => String(c.params?.name)).sort();
  expect(names.some((n) => n.startsWith('Beauty'))).toBe(true);
  expect(names.some((n) => n.startsWith('Depth'))).toBe(true);
  // distinct OPFS paths (suffixed by the export node id), both real video clips.
  const srcs = new Set(clips.map((c) => String(c.params?.src)));
  expect(srcs.size).toBe(2);
  for (const c of clips) {
    expect(c.params?.mediaKind).toBe('video');
    expect(String(c.params?.src)).toMatch(/^renders\/comfy_batch_.*\.mp4$/);
  }
});
