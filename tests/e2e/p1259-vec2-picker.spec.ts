// #1259 — a Vec2 channel's target and path, picked in the running app. The census places a
// composition with a media layer and diffs its composited frame, so a Layer's position and scale
// are offered to a vec2 channel and its anchor (which moves nothing drawn) is not.
//
// Driven through the real <select>s; the effect is read off the composited frame.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: { getState(): { dispatch: (op: unknown, src: string, d: string) => void } };
  __basher_selection: { getState(): { select: (id: string) => void } };
  __basher_time: { getState(): { setTime: (t: number) => void } };
  __basher_censusBuilders: {
    createNewComposition(): string;
    importMediaClipAsLayer(
      file: { relativePath: string; bytes: Uint8Array },
      compId: string,
    ): Promise<string | null>;
    compositeFrame(compId: string): Promise<ImageData | null>;
  };
}

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_selection && w.__basher_censusBuilders && w.__basher_time);
  });
}

const dispatch = (page: Page, op: unknown) =>
  page.evaluate(
    (o) => (window as unknown as W).__basher_dag.getState().dispatch(o, 'user', 'e2e'),
    op,
  );
const select = (page: Page, id: string) =>
  page.evaluate((n) => (window as unknown as W).__basher_selection.getState().select(n), id);
const at = (page: Page, t: number) =>
  page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), t);

function shown(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const s = el as HTMLSelectElement;
    return {
      value: s.value,
      selectedText: s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : null,
      enabled: [...s.options].filter((o) => !o.disabled).map((o) => o.value),
    };
  });
}

/** The composition's frame at the playhead, hashed — what a layer transform key moves. */
const frameHash = (page: Page, compId: string) =>
  page.evaluate(async (id) => {
    const img = await (window as unknown as W).__basher_censusBuilders.compositeFrame(id);
    if (!img) return 'none';
    const words = new Uint32Array(img.data.buffer);
    let h = 2166136261;
    for (let i = 0; i < words.length; i++) {
      h ^= words[i];
      h = Math.imul(h, 16777619);
    }
    return `${img.width}x${img.height}:${h >>> 0}`;
  }, compId);

test('a vec2 channel picks a layer and its position, and the composited frame moves', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const { compId, layerId } = await page.evaluate(async () => {
    const c = new OffscreenCanvas(48, 32);
    const g = c.getContext('2d')!;
    for (let x = 0; x < 48; x++)
      for (let y = 0; y < 32; y++) {
        g.fillStyle = `rgb(${30 + x * 4},${40 + y * 5},${200 - x * 2})`;
        g.fillRect(x, y, 1, 1);
      }
    const bytes = new Uint8Array(
      await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    const B = (window as unknown as W).__basher_censusBuilders;
    const comp = B.createNewComposition();
    const layer = await B.importMediaClipAsLayer({ relativePath: 'vec2-e2e.png', bytes }, comp);
    return { compId: comp, layerId: layer };
  });
  expect(layerId, 'a media layer was added').toBeTruthy();

  await dispatch(page, {
    type: 'addNode',
    nodeId: 'v2_e2e',
    nodeType: 'KeyframeChannelVec2',
    params: {
      keyframes: [
        { time: 0, value: [0, 0], easing: 'linear' },
        { time: 2, value: [12, 6], easing: 'linear' },
      ],
    },
  });
  await select(page, 'v2_e2e');
  const targets = await shown(page, 'inspector-options-v2_e2e-target');
  expect(targets.enabled, 'the layer is offered to a vec2 channel').toContain(layerId);

  // Control: aimed at the layer with no path, the composited frame does not change over time.
  await page.getByTestId('inspector-options-v2_e2e-target').selectOption(layerId!);
  await at(page, 0);
  const still0 = await frameHash(page, compId);
  expect(still0).not.toBe('none');
  await at(page, 2);
  await expect.poll(() => frameHash(page, compId), 'no path, no move').toBe(still0);

  const paths = await shown(page, 'inspector-options-v2_e2e-paramPath');
  // Exactly what moves the composite: position and scale, not the anchor.
  expect(paths.enabled.filter((v) => v !== '').sort()).toEqual([
    'transform.position',
    'transform.scale',
  ]);
  await page.getByTestId('inspector-options-v2_e2e-paramPath').selectOption('transform.position');
  await at(page, 0);
  await expect.poll(() => frameHash(page, compId)).toBe(still0);
  await at(page, 2);
  await expect
    .poll(() => frameHash(page, compId), 'the composited frame moves with the key')
    .not.toBe(still0);

  // The anchor, named by hand, shows why it is not offered.
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'anchor_e2e',
    nodeType: 'KeyframeChannelVec2',
    params: { target: layerId, paramPath: 'transform.anchor' },
  });
  await select(page, 'anchor_e2e');
  await expect
    .poll(() => shown(page, 'inspector-options-anchor_e2e-paramPath'))
    .toMatchObject({
      value: 'transform.anchor',
      selectedText: 'transform.anchor — nothing drawn changes',
    });
  expect(errors, 'no page errors').toEqual([]);
});
