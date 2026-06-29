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

test('keying the prompt mints a TEXT channel (dispatched by valueKind, not inferValueType)', async ({
  page,
}) => {
  // The load-bearing Mode-B authoring assertion (H104 + valueKind trap): keying the
  // STRING prompt param mints a KeyframeChannelText — NOT a KeyframeChannelColor (what
  // the native inferValueType road would wrongly pick). The channel targets comfy:6.text;
  // at 🎬 Render coherent clip the auto-inject path turns that keyframed param into a
  // basher_controller (no per-frame scrub — the inference preview compiler is retired).
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

  // The channel targets the comfy param path (comfy:6.text) — the address the render
  // bake reads + auto-injects a controller for.
  const target = await page.evaluate(() => {
    const ch = Object.values(
      (window as unknown as DagWindow).__basher_dag!.getState().state.nodes,
    ).find((n) => n.type === 'KeyframeChannelText');
    return ch?.params?.paramPath;
  });
  expect(target).toBe('comfy:6.text');
});

test('the panel folds the effect chain in as EFFECT sections (step 3)', async ({ page }) => {
  // Add a ColorCorrect effect onto the layer via the timeline twirl, then confirm the
  // Controls panel grows a second (EFFECT) section beside the SOURCE section, and that
  // keying a scalar effect param mints a KeyframeChannelNumber (the native road —
  // correct for a plain scalar; no comfy valueKind dispatch needed here).
  const layerId = await page.evaluate(
    () =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).find(
        (n) => n.type === 'Layer',
      )!.id,
  );
  await page.getByTestId(`layer-twirl-${layerId}`).click();
  await page.getByTestId(`layer-add-effect-${layerId}`).click();
  await page.waitForTimeout(150);
  await page.locator('[data-testid^="layer-bar-"]').first().click();

  // Two sections now: SOURCE (ComfyUI) + EFFECT (ColorCorrect).
  await expect(page.locator('[data-testid^="controls-section-"][data-role="source"]')).toHaveCount(
    1,
  );
  await expect(page.locator('[data-testid^="controls-section-"][data-role="effect"]')).toHaveCount(
    1,
  );

  const effectId = await page.evaluate(
    () =>
      Object.values((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).find(
        (n) => n.type === 'ColorCorrect',
      )!.id,
  );
  await expect(page.getByTestId(`controls-effect-input-${effectId}-brightness`)).toBeVisible();
  await page.getByTestId(`controls-effect-diamond-${effectId}-brightness`).click();
  await page.waitForTimeout(150);
  expect(await dagNodeTypes(page)).toContain('KeyframeChannelNumber');
});

test('a keyed comfy SOURCE param renders a dopesheet row + dot in the layer twirl', async ({
  page,
}) => {
  // The V81 timeline-mirror: the comfy param's authoring surface is the Controls panel
  // (the red diamond), but a keyed comfy:/controller: channel TARGETS the ComfyUIWorkflow
  // SOURCE node — not the Layer — so the LayerTimeline twirl never surfaced it. This wires
  // collectComfySourceChannelRows in: keying comfy:6.text (a TEXT channel) and comfy:3.cfg
  // (a NUMBER channel) yields two read-only twirl rows whose keyframe dots draw on the comp
  // ruler. Falsifiable: drop the comfy-prop visualRows and the rows/dots vanish.
  const ids = await page.evaluate(() => {
    const nodes = (window as unknown as DagWindow).__basher_dag!.getState().state.nodes;
    const comfy = Object.values(nodes).find((n) => n.type === 'ComfyUIWorkflow')!;
    const layer = Object.values(nodes).find((n) => n.type === 'Layer')!;
    return { comfyId: comfy.id, layerId: layer.id };
  });
  const { comfyId, layerId } = ids;

  const ruler = page.getByTestId('layer-timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + 2, box.y + box.height / 2);

  // Key a NUMBER param (comfy:3.cfg) and a TEXT param (comfy:6.text).
  await page.getByTestId(`comfy-param-input-${comfyId}-3-cfg`).fill('7');
  await page.getByTestId(`comfy-param-input-${comfyId}-3-cfg`).press('Enter');
  await page.getByTestId(`comfy-param-diamond-${comfyId}-3-cfg`).click();
  await page.getByTestId(`comfy-param-input-${comfyId}-6-text`).fill('a red sphere');
  await page.getByTestId(`comfy-param-input-${comfyId}-6-text`).press('Enter');
  await page.getByTestId(`comfy-param-diamond-${comfyId}-6-text`).click();
  await page.waitForTimeout(150);

  // Twirl the layer open → its dopesheet rows fold in.
  await page.getByTestId(`layer-twirl-${layerId}`).click();
  await page.waitForTimeout(150);

  // BOTH comfy source params now have a labelled outline row + a keyframe dot on the ruler.
  await expect(page.getByTestId(`layer-comfy-prop-row-${layerId}-comfy_3_cfg`)).toHaveText(
    'KSampler.cfg',
  );
  await expect(page.getByTestId(`layer-comfy-prop-row-${layerId}-comfy_6_text`)).toHaveText(
    'CLIPTextEncode.text',
  );
  await expect(page.getByTestId(`layer-comfy-keyframe-${layerId}-comfy_3_cfg`)).toHaveCount(1);
  await expect(page.getByTestId(`layer-comfy-keyframe-${layerId}-comfy_6_text`)).toHaveCount(1);
});
