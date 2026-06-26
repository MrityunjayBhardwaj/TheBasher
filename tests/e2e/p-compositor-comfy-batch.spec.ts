// Compositor Inc 4 — the COMPILED COHERENT path. "Render coherent clip" bakes the
// ComfyUIWorkflow layer's keyframes over its frame range into ONE batched workflow,
// submits it as a single batch (cap.submitBatch → N frames; the deterministic stub in
// CI), stitches the frames into an MP4 (the same createMp4Sink the 3D Render Animation
// uses), and registers it as a project video MediaClip — so the coherent clip becomes
// a droppable video layer. No server, no real model: this proves the COMPILER +
// CONTRACT + STITCH orchestration end-to-end (design §15: the stub is the CI gate; the
// compiled JSON is unit-snapshot-tested in comfyGraph.test).

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
  // Force the deterministic stub capability so this gate doesn't depend on (or hit)
  // a developer's locally-running ComfyUI — submitBatch then returns N fast frames.
  await page.evaluate(() => {
    (window as unknown as { __basher_useStubComfy?: () => void }).__basher_useStubComfy?.();
  });
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-add-layer').click();
  await page.getByTestId('video-mode-add-comfy').click();
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
  await page.locator('[data-testid^="layer-bar-"]').first().click();
});

test('Render coherent clip → batched submit → MP4 → project video MediaClip', async ({ page }) => {
  const comfyId = (await nodesOfType(page, 'ComfyUIWorkflow'))[0].id;

  // Pin a small, deterministic frame range on the comfy node (default is 0..60) so
  // the batch is exactly 4 frames — fast + an exact assertion target.
  await page.evaluate((id) => {
    (window as unknown as DagWindow).__basher_dag!.getState().dispatchAtomic(
      [
        { type: 'setParam', nodeId: id, paramPath: 'frameStart', value: 0 },
        { type: 'setParam', nodeId: id, paramPath: 'frameEnd', value: 3 },
      ],
      'user',
      'test: pin range',
    );
  }, comfyId);

  // Animate a SCHEDULABLE float (KSampler.cfg, node 3) with two keys so the compiler
  // inserts a BasherValueSchedule (the schedule path, not a constant).
  const inputId = `comfy-param-input-${comfyId}-3-cfg`;
  const diamondId = `comfy-param-diamond-${comfyId}-3-cfg`;
  const ruler = page.getByTestId('layer-timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await page.getByTestId(inputId).fill('6');
  await page.getByTestId(inputId).press('Enter');
  await page.getByTestId(diamondId).click();
  await page.waitForTimeout(120);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.getByTestId(inputId).fill('12');
  await page.getByTestId(inputId).press('Enter');
  await page.getByTestId(diamondId).click();
  await page.waitForTimeout(120);
  expect((await nodesOfType(page, 'KeyframeChannelNumber')).length).toBeGreaterThan(0);

  // No MediaClip yet (the comfy SOURCE is a generator, not a media node).
  expect(await nodesOfType(page, 'MediaClip')).toHaveLength(0);

  // Render the coherent clip.
  await page.getByTestId(`comfy-render-clip-${comfyId}`).click();

  // A project video MediaClip appears, named for the workflow, with srcFrames = N (4).
  await expect
    .poll(async () => (await nodesOfType(page, 'MediaClip')).length, { timeout: 20000 })
    .toBe(1);
  const clip = (await nodesOfType(page, 'MediaClip'))[0];
  expect(clip.params?.mediaKind).toBe('video');
  expect(clip.params?.srcFrames).toBe(4);
  expect(String(clip.params?.src)).toMatch(/^renders\/comfy_batch_.*\.mp4$/);

  // The bytes were actually written to OPFS (a real, non-empty MP4 with an ftyp box).
  // OpfsStorage nests everything under a 'basher' root dir.
  const head = await page.evaluate(async (src) => {
    const top = await navigator.storage.getDirectory();
    const root = await top.getDirectoryHandle('basher');
    const dir = await root.getDirectoryHandle('renders');
    const fname = (src as string).split('/').pop()!;
    const fh = await dir.getFileHandle(fname);
    const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
    return { len: buf.length, tag: String.fromCharCode(...buf.slice(4, 8)) };
  }, clip.params?.src);
  expect(head.len).toBeGreaterThan(0);
  expect(head.tag).toBe('ftyp');
});
