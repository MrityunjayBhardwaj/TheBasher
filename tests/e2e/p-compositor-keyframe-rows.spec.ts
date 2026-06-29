// Compositor spine 1c.3c-i — the twirl-down keyframe property rows (the dopesheet
// folding in). Falsifiable against the REAL app: a layer's twirl opens Opacity +
// Rotation rows; clicking a row's diamond keys that param via a free-floating V57
// channel targeting the Layer node (a dopesheet diamond then renders on the comp
// ruler and the inspector diamond reads 'on-key'); editing the value field writes
// the Layer param. Unwire the diamond/channel or the field and an assertion drops.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
}

/** Does a free-floating channel target (layerId, paramPath)? */
function hasChannel(page: import('@playwright/test').Page, layerId: string, paramPath: string) {
  return page.evaluate(
    ({ id, path }) => {
      const w = window as unknown as DagWindow;
      const nodes = w.__basher_dag?.getState().state.nodes ?? {};
      return Object.values(nodes).some((n) => {
        const p = n.params as { target?: unknown; paramPath?: unknown } | undefined;
        return p?.target === id && p?.paramPath === path;
      });
    },
    { id: layerId, path: paramPath },
  );
}

function layerOpacity(page: import('@playwright/test').Page, layerId: string) {
  return page.evaluate((id) => {
    const w = window as unknown as DagWindow;
    const p = w.__basher_dag?.getState().state.nodes[id]?.params as
      | { opacity?: number }
      | undefined;
    return p?.opacity;
  }, layerId);
}

/** The keyframe times (ascending) of the channel targeting (layerId, paramPath). */
function channelTimes(page: import('@playwright/test').Page, layerId: string, paramPath: string) {
  return page.evaluate(
    ({ id, path }) => {
      const w = window as unknown as DagWindow;
      const nodes = w.__basher_dag?.getState().state.nodes ?? {};
      const ch = Object.values(nodes).find((n) => {
        const p = n.params as { target?: unknown; paramPath?: unknown } | undefined;
        return p?.target === id && p?.paramPath === path;
      });
      const kfs = (ch?.params as { keyframes?: Array<{ time: number }> } | undefined)?.keyframes;
      return (kfs ?? []).map((k) => k.time).sort((a, b) => a - b);
    },
    { id: layerId, path: paramPath },
  );
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
  const row = page.locator('[data-testid^="layer-twirl-"]').first();
  const testId = await row.getAttribute('data-testid');
  return testId!.replace('layer-twirl-', '');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await addClip(page);
});

test('the twirl opens opacity + rotation rows; keying opacity creates a channel + a dopesheet diamond', async ({
  page,
}) => {
  const id = await firstLayerId(page);

  // Closed by default → no property rows.
  await expect(page.getByTestId(`layer-prop-row-${id}-opacity`)).toHaveCount(0);

  await page.getByTestId(`layer-twirl-${id}`).click();
  await expect(page.getByTestId(`layer-prop-row-${id}-opacity`)).toBeVisible();
  await expect(page.getByTestId(`layer-prop-row-${id}-rotation`)).toBeVisible();

  // No channel yet.
  expect(await hasChannel(page, id, 'opacity')).toBe(false);

  // Key opacity at the playhead.
  const diamond = page.getByTestId(`layer-prop-diamond-${id}-opacity`);
  await expect(diamond).toHaveAttribute('data-anim-state', 'none');
  await diamond.click();

  // A V57 channel now targets the Layer's opacity, the inspector diamond reads
  // on-key, and a dopesheet diamond renders on the track.
  expect(await hasChannel(page, id, 'opacity')).toBe(true);
  await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');
  await expect(page.locator(`[data-testid="layer-keyframe-${id}-opacity"]`)).toHaveCount(1);
});

test('a track diamond drags to RETIME the key (off frame 0) — surface-agnostic channel edit', async ({
  page,
}) => {
  const id = await firstLayerId(page);
  await page.getByTestId(`layer-twirl-${id}`).click();
  await page.getByTestId(`layer-prop-diamond-${id}-opacity`).click();
  expect(await channelTimes(page, id, 'opacity')).toEqual([0]);

  // Drag the frame-0 diamond to the right → retime to a later frame.
  const dia = page.locator(`[data-testid="layer-keyframe-${id}-opacity"]`).first();
  const box = (await dia.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  const after = await channelTimes(page, id, 'opacity');
  expect(after).toHaveLength(1);
  expect(after[0]).toBeGreaterThan(0); // retimed off frame 0 (value+easing preserved by the composite)
});

test('Alt-clicking a track diamond DELETES the key', async ({ page }) => {
  const id = await firstLayerId(page);
  await page.getByTestId(`layer-twirl-${id}`).click();
  await page.getByTestId(`layer-prop-diamond-${id}-opacity`).click();
  await expect(page.locator(`[data-testid="layer-keyframe-${id}-opacity"]`)).toHaveCount(1);

  await page
    .locator(`[data-testid="layer-keyframe-${id}-opacity"]`)
    .first()
    .click({ modifiers: ['Alt'] });

  await expect(page.locator(`[data-testid="layer-keyframe-${id}-opacity"]`)).toHaveCount(0);
  expect(await channelTimes(page, id, 'opacity')).toEqual([]);
});

test('editing the opacity field writes the Layer param', async ({ page }) => {
  const id = await firstLayerId(page);
  await page.getByTestId(`layer-twirl-${id}`).click();

  expect(await layerOpacity(page, id)).toBe(1);

  const input = page.getByTestId(`layer-prop-input-${id}-opacity`);
  await input.fill('0.4');
  await input.press('Enter');

  expect(await layerOpacity(page, id)).toBeCloseTo(0.4, 5);
});
