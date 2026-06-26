// Compositor Inc 3 Slice D — the Controls panel authors a ComfyUI graph param.
// The dedicated VIDEO-space Controls panel (§7.1) renders the selected layer's
// producer pipeline: a ComfyUIWorkflow SOURCE section exposes the imported graph's
// manifest — schedulable params as animatable rows (value field + diamond), structural
// params read-only. Authoring a key on a schedulable param drives the composite at the
// playhead (the render-identical resolveEvaluatedParam read, H40), provable vs the
// deterministic stub — no server, no GPU.
//
// The load-bearing assertion (the H104 + valueKind trap): keying the STRING prompt
// param must mint a KeyframeChannelText — NOT a KeyframeChannelColor (what the native
// inferValueType road would wrongly pick for a string). Falsifiable: route comfy
// first-keys through inferValueType and the channel type flips to Color → this fails.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
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

function dagNodeTypes(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).map(
      (n) => n.type,
    ),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-add-layer').click();
  await page.getByTestId('video-mode-add-comfy').click();
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', { timeout: 8000 });
  // Select the comfy layer → the Controls panel binds to it.
  await page.locator('[data-testid^="layer-bar-"]').first().click();
});

test('the Controls panel exposes the comfy manifest (schedulable + structural)', async ({
  page,
}) => {
  const comfyId = await page.evaluate(
    () =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).find(
        (n) => n.type === 'ComfyUIWorkflow',
      )!.id,
  );

  // SOURCE section for the comfy producer, with its manifest body.
  await expect(page.getByTestId(`controls-panel-layer-name`)).toHaveText('ComfyUI');
  await expect(page.getByTestId(`comfy-controls-${comfyId}`)).toBeVisible();

  // A SCHEDULABLE prompt param (CLIPTextEncode.text on node 6) → animatable row
  // (value field + diamond).
  await expect(page.getByTestId(`comfy-param-input-${comfyId}-6-text`)).toBeVisible();
  await expect(page.getByTestId(`comfy-param-diamond-${comfyId}-6-text`)).toBeVisible();

  // A STRUCTURAL param (EmptyLatentImage.width on node 5) → read-only, no diamond.
  await expect(page.getByTestId(`comfy-structural-row-${comfyId}-5-width`)).toBeVisible();
  await expect(page.getByTestId(`comfy-param-diamond-${comfyId}-5-width`)).toHaveCount(0);
});

test('keying the prompt mints a TEXT channel and drives the composite across a scrub', async ({
  page,
}) => {
  const comfyId = await page.evaluate(
    () =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).find(
        (n) => n.type === 'ComfyUIWorkflow',
      )!.id,
  );
  const inputId = `comfy-param-input-${comfyId}-6-text`;
  const diamondId = `comfy-param-diamond-${comfyId}-6-text`;

  const ruler = page.getByTestId('layer-timeline-ruler');
  const box = (await ruler.boundingBox())!;

  // Frame 0: set the prompt + key it (the diamond's first-key path).
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await page.getByTestId(inputId).fill('a red sphere');
  await page.getByTestId(inputId).press('Enter');
  await page.getByTestId(diamondId).click();
  await page.waitForTimeout(150);

  // The channel TYPE is dispatched by valueKind: a STRING param → KeyframeChannelText
  // (NOT KeyframeChannelColor — the inferValueType trap the design forbids).
  const types = await dagNodeTypes(page);
  expect(types).toContain('KeyframeChannelText');
  expect(types).not.toContain('KeyframeChannelColor');

  const atStart = await pixelChecksum(page);

  // Mid frame: change the prompt (held transient) + key it → a 2nd keyframe.
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.getByTestId(inputId).fill('a blue pyramid in a desert');
  await page.getByTestId(inputId).press('Enter');
  await page.getByTestId(diamondId).click();
  await page.waitForTimeout(200);
  const atMid = await pixelChecksum(page);

  // The prompt-at-frame changed → the resolved stub frame changed.
  expect(atStart).not.toBe(atMid);

  // Back to frame 0 → the first key still holds its value (a real two-key animation).
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  expect(await pixelChecksum(page)).toBe(atStart);
});
