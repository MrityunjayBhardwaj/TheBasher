// Compositor 1c.3c-ii — keyframeable Vec2 layer props (Position / Scale).
// Falsifiable against the REAL app: a layer's twirl opens Position + Scale rows,
// each with TWO axis fields + ONE diamond; clicking the diamond keys the WHOLE
// vector via a free-floating KeyframeChannelVec2 targeting the Layer node (a
// dopesheet diamond renders on the comp ruler, the inspector diamond reads
// 'on-key'); editing an axis writes the whole [x,y]. And the READ PATH is H40-
// ready: a 2-key scale animation drives the live composite across a scrub (a
// shrunk red region = lower mean). Unwire the diamond/channel, the field, or the
// compositeDecode vec2 overlay and an assertion drops.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
}

/** The TYPE of the free-floating channel targeting (layerId, paramPath), or null. */
function channelType(page: import('@playwright/test').Page, layerId: string, paramPath: string) {
  return page.evaluate(
    ({ id, path }) => {
      const w = window as unknown as DagWindow;
      const nodes = w.__basher_dag?.getState().state.nodes ?? {};
      const ch = Object.values(nodes).find((n) => {
        const p = n.params as { target?: unknown; paramPath?: unknown } | undefined;
        return p?.target === id && p?.paramPath === path;
      });
      return ch?.type ?? null;
    },
    { id: layerId, path: paramPath },
  );
}

/** The authored transform sub-vector ('position' | 'scale') on a layer. */
function layerVec(page: import('@playwright/test').Page, layerId: string, key: string) {
  return page.evaluate(
    ({ id, k }) => {
      const w = window as unknown as DagWindow;
      const t = (w.__basher_dag?.getState().state.nodes[id]?.params as { transform?: unknown })
        ?.transform as Record<string, unknown> | undefined;
      return t?.[k];
    },
    { id: layerId, k: key },
  );
}

function setTime(page: import('@playwright/test').Page, seconds: number) {
  return page.evaluate((s) => {
    (window as unknown as DagWindow).__basher_time?.getState().setTime(s);
  }, seconds);
}

/** Mean of R+G+B over the composite canvas (the live pixels). */
function meanBrightness(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let s = 0;
    for (let i = 0; i < data.length; i += 4) s += data[i] + data[i + 1] + data[i + 2];
    return s / (data.length / 4);
  });
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

async function twirlOpenFirstLayer(page: import('@playwright/test').Page): Promise<string> {
  const twirl = page.locator('[data-testid^="layer-twirl-"]').first();
  const id = (await twirl.getAttribute('data-testid'))!.replace('layer-twirl-', '');
  await twirl.click();
  return id;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await addClip(page);
});

test('the twirl opens Position + Scale rows; keying Position creates a KeyframeChannelVec2 + a dopesheet diamond', async ({
  page,
}) => {
  const id = await twirlOpenFirstLayer(page);

  await expect(page.getByTestId(`layer-prop-row-${id}-position`)).toBeVisible();
  await expect(page.getByTestId(`layer-prop-row-${id}-scale`)).toBeVisible();
  // Two axis fields per vector row.
  await expect(page.getByTestId(`layer-prop-input-${id}-position-x`)).toBeVisible();
  await expect(page.getByTestId(`layer-prop-input-${id}-position-y`)).toBeVisible();

  // No channel yet.
  expect(await channelType(page, id, 'transform.position')).toBeNull();

  // Key position at the playhead → a vec2 channel targets the Layer node, the
  // diamond reads on-key, and a dopesheet diamond renders on the track.
  const diamond = page.getByTestId(`layer-prop-diamond-${id}-position`);
  await expect(diamond).toHaveAttribute('data-anim-state', 'none');
  await diamond.click();

  expect(await channelType(page, id, 'transform.position')).toBe('KeyframeChannelVec2');
  await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');
  await expect(page.locator(`[data-testid="layer-keyframe-${id}-position"]`)).toHaveCount(1);
});

test('editing one axis writes the WHOLE position vector', async ({ page }) => {
  const id = await twirlOpenFirstLayer(page);

  expect(await layerVec(page, id, 'position')).toEqual([0, 0]);

  const x = page.getByTestId(`layer-prop-input-${id}-position-x`);
  await x.fill('50');
  await x.press('Enter');

  expect(await layerVec(page, id, 'position')).toEqual([50, 0]);
});

test('an animated Scale drives the live composite across a scrub (read path H40)', async ({
  page,
}) => {
  const id = await twirlOpenFirstLayer(page);

  // The full-size red composite.
  const base = await meanBrightness(page);
  expect(base).toBeGreaterThan(1);

  // Key 1: scale [1,1] (identity) at frame 0.
  await setTime(page, 0);
  await page.getByTestId(`layer-prop-diamond-${id}-scale`).click();

  // Key 2: scrub to 2.5s, shrink X to 0.3 (a single-axis edit writes the whole
  // [0.3,1] vector), then persist the held edit as a key (animated edit → transient;
  // the diamond keys the transient — the #149 path).
  await setTime(page, 2.5);
  const sx = page.getByTestId(`layer-prop-input-${id}-scale-x`);
  await sx.fill('0.3');
  await sx.press('Enter');
  await page.getByTestId(`layer-prop-diamond-${id}-scale`).click();

  await expect(page.locator(`[data-testid="layer-keyframe-${id}-scale"]`)).toHaveCount(2);

  // Scrub to the [1,1] key → full-width red; scrub to the [0.3,1] key → the red
  // region is squeezed to 0.3 width = fewer red pixels = lower mean. The composite
  // reads the EVALUATED scale (resolveEvaluatedParam) for free — viewer + export.
  await setTime(page, 0);
  await expect.poll(() => meanBrightness(page)).toBeGreaterThan(base * 0.9);
  await setTime(page, 2.5);
  await expect.poll(() => meanBrightness(page)).toBeLessThan(base * 0.6);
});
