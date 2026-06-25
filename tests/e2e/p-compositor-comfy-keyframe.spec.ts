// Compositor inc 3 — keyframe-ANY-param (the V81 headline). A ComfyUIWorkflow layer
// carries an imported workflow (the SD1.5 starter graph); binding a free-floating V57
// KeyframeChannelText to its prompt param (paramPath `comfy:6.text`) makes the prompt
// travel: the compositor resolves each schedulable graph param at the playhead via the
// render-identical resolveEvaluatedParam (H40), so scrubbing changes the composited
// (stub) frame. Provable vs the deterministic stub — no server, no GPU (design §14
// Inc-3 gate: "scrub → frames change"). Falsifiable: remove the resolve and both
// frames are identical → the pixel-diff assertion drops.

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
      dispatchAtomic: (ops: unknown[], origin: string, label: string) => void;
    };
  };
}

/** A cheap checksum over the composite canvas pixels. */
function pixelChecksum(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let h = 0;
    for (let i = 0; i < data.length; i += 17) h = (h * 31 + data[i]) >>> 0;
    return h;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-add-layer').click();
  await page.getByTestId('video-mode-add-comfy').click();
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
});

test('a keyframed ComfyUI prompt drives the composite across a scrub', async ({ page }) => {
  // Bind a free-floating KeyframeChannelText to the comfy node's positive prompt
  // (node 6): 0s='a green cube' → 2.5s='a red sphere' (the 5s comp). The channel
  // targets the ComfyUIWorkflow node directly (post-#199 free-floating road, V57).
  const channelType = await page.evaluate(() => {
    const dag = (window as unknown as DagWindow).__basher_dag!.getState();
    const comfy = Object.values(dag.state.nodes).find((n) => n.type === 'ComfyUIWorkflow')!;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'prompt_channel',
          nodeType: 'KeyframeChannelText',
          params: {
            name: 'prompt',
            target: comfy.id,
            paramPath: 'comfy:6.text',
            keyframes: [
              { time: 0, value: 'a green cube', easing: 'linear' },
              { time: 2.5, value: 'a red sphere', easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'inject prompt channel',
    );
    return (window as unknown as DagWindow).__basher_dag!.getState().state.nodes['prompt_channel']
      ?.type;
  });
  expect(channelType).toBe('KeyframeChannelText');

  const ruler = page.getByTestId('layer-timeline-ruler');
  const box = (await ruler.boundingBox())!;

  // Scrub to frame 0 (before the 2nd key) then to ~frame 75 (past it).
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await page.waitForTimeout(250);
  const atStart = await pixelChecksum(page);

  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.waitForTimeout(250);
  const atMid = await pixelChecksum(page);

  // The prompt-at-frame changed → the resolved stub frame changed.
  expect(atStart).not.toBe(atMid);
});
