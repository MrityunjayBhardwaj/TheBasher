// Compositor spine 1c.3b-ii — dragging an outline row reorders the comp's layers.
// Falsifiable against the REAL app: dragging the front (top) row down past the
// back row flips the order of Composition.inputs.layers (the DAG edge list), and a
// LOCKED row can't be dragged so the order is unchanged. Unwire the reorder
// dispatch or the lock gate and an assertion drops.

import { expect, test } from './_fixtures';

interface DagRef {
  node: string;
  socket: string;
}
interface DagNode {
  id: string;
  type: string;
  inputs?: Record<string, DagRef | DagRef[] | undefined>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
}

/** The comp's layer node ids in DAG edge order (0=back…last=front). */
function layerOrder(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const nodes = w.__basher_dag?.getState().state.nodes ?? {};
    const comp = Object.values(nodes).find((n) => n.type === 'Composition');
    const layers = comp?.inputs?.layers;
    const arr = Array.isArray(layers) ? layers : layers ? [layers] : [];
    return arr.map((r) => r.node);
  });
}

async function addClip(page: import('@playwright/test').Page, n: number) {
  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText(
    `${n} layer${n > 1 ? 's' : ''}`,
    { timeout: 8_000 },
  );
}

/** Press at the center of a row, drag down by `dy`, release. */
async function dragRowY(page: import('@playwright/test').Page, rowTestId: string, dy: number) {
  const box = (await page.getByTestId(rowTestId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
});

test('dragging the front row to the back flips the layer order', async ({ page }) => {
  await addClip(page, 1);
  await addClip(page, 2);
  const before = await layerOrder(page); // [back, front]
  expect(before).toHaveLength(2);
  const front = before[1];

  // The front layer renders as the TOP outline row; drag it down past the back row.
  await dragRowY(page, `layer-row-${front}`, 40);

  const after = await layerOrder(page);
  expect(after).toEqual([before[1], before[0]]); // front moved to the back
});

test('a locked row cannot be dragged to reorder', async ({ page }) => {
  await addClip(page, 1);
  await addClip(page, 2);
  const before = await layerOrder(page);
  const front = before[1];

  await page.getByTestId(`layer-lock-${front}`).click();
  await dragRowY(page, `layer-row-${front}`, 40);

  expect(await layerOrder(page)).toEqual(before); // unchanged
});
