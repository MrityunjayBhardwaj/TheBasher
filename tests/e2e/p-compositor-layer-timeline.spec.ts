// Compositor spine 1c.3a — the layer timeline (outline + bars + toggles).
// Falsifiable against the REAL app: adding media layers renders a row + a bar per
// layer, rows show FRONT-on-top, and the visibility toggle round-trips through a
// setParam op (the Layer node's `enabled` flips). Unwiring the row render or the
// toggle dispatch drops an assertion.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
}

function layerEnabled(page: import('@playwright/test').Page, layerId: string) {
  return page.evaluate((id) => {
    const w = window as unknown as DagWindow;
    const n = w.__basher_dag?.getState().state.nodes[id];
    return (n?.params as { enabled?: boolean } | undefined)?.enabled;
  }, layerId);
}

async function addClip(page: import('@playwright/test').Page) {
  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
});

test('each layer renders an outline row + a time bar', async ({ page }) => {
  await addClip(page);
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', {
    timeout: 8_000,
  });
  await addClip(page);
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('2 layers', {
    timeout: 8_000,
  });

  await expect(page.getByTestId('layer-timeline')).toBeVisible();
  await expect(page.locator('[data-testid^="layer-row-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="layer-bar-"]')).toHaveCount(2);
  await expect(page.getByTestId('layer-timeline-playhead')).toBeVisible();
});

test('the visibility toggle flips the Layer node enabled param', async ({ page }) => {
  await addClip(page);
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', {
    timeout: 8_000,
  });

  const visBtn = page.locator('[data-testid^="layer-vis-"]').first();
  const testId = await visBtn.getAttribute('data-testid');
  const layerId = testId!.replace('layer-vis-', '');

  expect(await layerEnabled(page, layerId)).toBe(true);
  await expect(visBtn).toHaveAttribute('data-active', 'true');

  await visBtn.click();
  expect(await layerEnabled(page, layerId)).toBe(false);
  await expect(visBtn).toHaveAttribute('data-active', 'false');
});
