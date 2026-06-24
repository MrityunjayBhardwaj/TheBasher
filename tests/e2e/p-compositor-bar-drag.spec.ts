// Compositor spine 1c.3b-i — dragging a layer bar trims/slides it.
// Falsifiable against the REAL app: grabbing a bar's left handle and dragging
// right moves inPoint + startFrame together (the right edge stays put); grabbing
// the body and dragging slides startFrame; a LOCKED layer has no drag handles at
// all. Each drag round-trips through one setParam batch on the Layer node — unwire
// the pointer handlers or the geometry and an assertion drops.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
}

interface LayerParams {
  startFrame: number;
  inPoint: number;
  outPoint: number;
}

function layerParams(page: import('@playwright/test').Page, layerId: string): Promise<LayerParams> {
  return page.evaluate((id) => {
    const w = window as unknown as DagWindow;
    const p = (w.__basher_dag?.getState().state.nodes[id]?.params ?? {}) as Record<string, unknown>;
    return {
      startFrame: Number(p.startFrame ?? 0),
      inPoint: Number(p.inPoint ?? 0),
      outPoint: Number(p.outPoint ?? -1),
    };
  }, layerId);
}

async function addClip(page: import('@playwright/test').Page) {
  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', {
    timeout: 8_000,
  });
}

async function firstLayerId(page: import('@playwright/test').Page): Promise<string> {
  const bar = page.locator('[data-testid^="layer-handle-trim-left-"]').first();
  const testId = await bar.getAttribute('data-testid');
  return testId!.replace('layer-handle-trim-left-', '');
}

/** Press at the center of `box`, drag horizontally by `dx`, release. */
async function dragX(
  page: import('@playwright/test').Page,
  box: { x: number; y: number; width: number; height: number },
  dx: number,
) {
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
});

test('dragging the left handle right trims inPoint + startFrame, the right edge stays', async ({
  page,
}) => {
  await addClip(page);
  const id = await firstLayerId(page);
  // A still spans the comp: startFrame 0, inPoint 0, outPoint = durationFrames (150).
  const before = await layerParams(page, id);
  expect(before.startFrame).toBe(0);
  expect(before.inPoint).toBe(0);
  const rightEdge = before.startFrame + (before.outPoint - before.inPoint);

  const handle = await page.getByTestId(`layer-handle-trim-left-${id}`).boundingBox();
  await dragX(page, handle!, 140);

  const after = await layerParams(page, id);
  // trim-left moves start + inPoint by the same amount → they stay equal…
  expect(after.inPoint).toBeGreaterThan(0);
  expect(after.startFrame).toBe(after.inPoint);
  // …and the right edge (startFrame + length) is unchanged.
  expect(after.startFrame + (after.outPoint - after.inPoint)).toBe(rightEdge);
});

test('dragging the body slides startFrame without re-trimming', async ({ page }) => {
  await addClip(page);
  const id = await firstLayerId(page);
  const before = await layerParams(page, id);

  const body = await page.getByTestId(`layer-handle-slide-${id}`).boundingBox();
  await dragX(page, body!, 120);

  const after = await layerParams(page, id);
  expect(after.startFrame).toBeGreaterThan(0);
  expect(after.inPoint).toBe(before.inPoint); // unchanged
  expect(after.outPoint).toBe(before.outPoint); // unchanged
});

test('a locked layer has no drag handles', async ({ page }) => {
  await addClip(page);
  const id = await firstLayerId(page);

  await page.getByTestId(`layer-lock-${id}`).click();

  await expect(page.getByTestId(`layer-handle-trim-left-${id}`)).toHaveCount(0);
  await expect(page.getByTestId(`layer-handle-trim-right-${id}`)).toHaveCount(0);
  // The bar itself still renders (selectable), it just can't be dragged.
  await expect(page.getByTestId(`layer-bar-${id}`)).toBeVisible();
});
