// Compositor inc 2b — keyframeable effect params. Falsifiable against the REAL
// app: an effect's twirl opens Brightness/Contrast/Saturation sub-rows; clicking a
// sub-row's diamond keys that param via a free-floating V57 channel targeting the
// EFFECT node (a dopesheet diamond renders on the comp ruler and the inspector
// diamond reads 'on-key'); editing the value field writes the effect param. And the
// READ PATH is H40-ready: a 2-key brightness animation drives the live composite
// across a scrub (full red at the 1.0 key, dark at the 0.3 key). Unwire the diamond/
// channel, the field, or the compositeDecode overlay and an assertion drops.

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

/** Does a free-floating channel target (nodeId, paramPath)? */
function hasChannel(page: import('@playwright/test').Page, nodeId: string, paramPath: string) {
  return page.evaluate(
    ({ id, path }) => {
      const w = window as unknown as DagWindow;
      const nodes = w.__basher_dag?.getState().state.nodes ?? {};
      return Object.values(nodes).some((n) => {
        const p = n.params as { target?: unknown; paramPath?: unknown } | undefined;
        return p?.target === id && p?.paramPath === path;
      });
    },
    { id: nodeId, path: paramPath },
  );
}

/** The authored value of a node param (the effect's `brightness`/`contrast`). */
function effectParam(page: import('@playwright/test').Page, nodeId: string, key: string) {
  return page.evaluate(
    ({ id, k }) => {
      const w = window as unknown as DagWindow;
      const p = w.__basher_dag?.getState().state.nodes[id]?.params as
        | Record<string, number>
        | undefined;
      return p?.[k];
    },
    { id: nodeId, k: key },
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

/** Add a Color Correct effect to the first (only) layer and return its node id. */
async function addEffect(page: import('@playwright/test').Page): Promise<string> {
  await page.locator('[data-testid^="layer-twirl-"]').first().click();
  await page.locator('[data-testid^="layer-add-effect-"]').first().click();
  const twirl = page.locator('[data-testid^="layer-effect-twirl-"]').first();
  await expect(twirl).toBeVisible();
  const testId = await twirl.getAttribute('data-testid');
  return testId!.replace('layer-effect-twirl-', '');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await addClip(page);
});

test('the effect twirl opens param sub-rows; keying brightness creates a channel + a dopesheet diamond', async ({
  page,
}) => {
  const fx = await addEffect(page);

  // Closed by default → no param sub-rows.
  await expect(page.getByTestId(`layer-effect-prop-row-${fx}-brightness`)).toHaveCount(0);

  await page.getByTestId(`layer-effect-twirl-${fx}`).click();
  await expect(page.getByTestId(`layer-effect-prop-row-${fx}-brightness`)).toBeVisible();
  await expect(page.getByTestId(`layer-effect-prop-row-${fx}-contrast`)).toBeVisible();
  await expect(page.getByTestId(`layer-effect-prop-row-${fx}-saturation`)).toBeVisible();

  // No channel yet.
  expect(await hasChannel(page, fx, 'brightness')).toBe(false);

  // Key brightness at the playhead → channel targets the EFFECT node, the diamond
  // reads on-key, and a dopesheet diamond renders on the effect's track row.
  const diamond = page.getByTestId(`layer-effect-diamond-${fx}-brightness`);
  await expect(diamond).toHaveAttribute('data-anim-state', 'none');
  await diamond.click();

  expect(await hasChannel(page, fx, 'brightness')).toBe(true);
  await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');
  await expect(page.locator(`[data-testid="layer-effect-keyframe-${fx}-brightness"]`)).toHaveCount(
    1,
  );
});

test('editing an effect param field writes the effect node param', async ({ page }) => {
  const fx = await addEffect(page);
  await page.getByTestId(`layer-effect-twirl-${fx}`).click();

  expect(await effectParam(page, fx, 'contrast')).toBe(1);

  const input = page.getByTestId(`layer-effect-prop-input-${fx}-contrast`);
  await input.fill('1.5');
  await input.press('Enter');

  expect(await effectParam(page, fx, 'contrast')).toBeCloseTo(1.5, 5);
});

test('an animated brightness drives the live composite across a scrub (read path H40)', async ({
  page,
}) => {
  const fx = await addEffect(page);
  await page.getByTestId(`layer-effect-twirl-${fx}`).click();

  // The ungraded full-red composite.
  const base = await meanBrightness(page);
  expect(base).toBeGreaterThan(1);

  // Key 1: brightness 1.0 (default/identity) at frame 0.
  await setTime(page, 0);
  await page.getByTestId(`layer-effect-diamond-${fx}-brightness`).click();

  // Key 2: scrub to 2.5s, darken to 0.3, then persist the held edit as a key
  // (animated edit → transient; the diamond keys the transient — the #149 path).
  await setTime(page, 2.5);
  const input = page.getByTestId(`layer-effect-prop-input-${fx}-brightness`);
  await input.fill('0.3');
  await input.press('Enter');
  await page.getByTestId(`layer-effect-diamond-${fx}-brightness`).click();

  // Two keys on the track.
  await expect(page.locator(`[data-testid="layer-effect-keyframe-${fx}-brightness"]`)).toHaveCount(
    2,
  );

  // Scrub to the 1.0 key → full red; scrub to the 0.3 key → darkened. The composite
  // reads the EVALUATED brightness (resolveEvaluatedParam) for free — viewer + export.
  await setTime(page, 0);
  await expect.poll(() => meanBrightness(page)).toBeGreaterThan(base * 0.9);
  await setTime(page, 2.5);
  await expect.poll(() => meanBrightness(page)).toBeLessThan(base * 0.6);
});
