// #1845 — I keys the row under the mouse, on any setting that has a key, and a press that keys
// nothing says so. Every row asserts the keys it added, beside a control that must add some.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { params: { keyframes?: unknown[]; value?: number } }>;
        outputs: { scene?: { node: string } };
      };
      dispatchAtomic: (ops: unknown[], source: string, description: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_mesh_world_position: (id: string) => number[] | null;
}

async function boot(page: Page, withTimeline: boolean) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<W>).__basher_dag?.getState().state.outputs.scene),
  );
  if (withTimeline) await page.getByTestId('floating-toolbar-timeline').click();
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_time.getState().pause();
    w.__basher_time.getState().setTime(0);
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'e_cd',
          nodeType: 'CurveData',
          params: {
            points: [
              { id: 'cp0', co: [0, 0, 0] },
              { id: 'cp1', co: [10, 0, 0] },
            ],
            closed: false,
            resolution: 32,
          },
        },
        { type: 'addNode', nodeId: 'e_c', nodeType: 'Object', params: {} },
        {
          type: 'connect',
          from: { node: 'e_cd', socket: 'out' },
          to: { node: 'e_c', socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'e_c', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        {
          type: 'addNode',
          nodeId: 'e_f',
          nodeType: 'FollowPath',
          params: { target: 'n_box', curve: 'e_c', evalTime: 1 },
        },
      ],
      'user',
      'e2e',
    );
  });
}

const select = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as W).__basher_selection.getState().select(i), id);
const setTime = (page: Page, s: number) =>
  page.evaluate((t) => (window as unknown as W).__basher_time.getState().setTime(t), s);
const keyCount = (page: Page) =>
  page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    let n = 0;
    for (const node of Object.values(nodes)) n += node.params.keyframes?.length ?? 0;
    return n;
  });
const influenceKeys = (page: Page) =>
  page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return (nodes['e_f_influence_value_value_channel']?.params.keyframes ?? []) as {
      time: number;
    }[];
  });
const said = (page: Page, text: string) => expect(page.getByText(text).first()).toBeVisible();

test('I over the Influence row, at 1 with no diamond yet, wires the blend and keys it', async ({
  page,
}) => {
  await boot(page, false);
  await select(page, 'e_f');
  await page.getByTestId('constraint-influence').hover();
  await page.keyboard.press('i');
  await expect.poll(() => influenceKeys(page).then((k) => k.length)).toBe(1);
});

test('I over a keyed row adds keys and never removes one; the drawer is not needed', async ({
  page,
}) => {
  await boot(page, false);
  await select(page, 'e_f');
  await page.getByTestId('constraint-influence-key').click();
  const diamond = page.getByTestId('inspector-diamond-e_f_influence_value-value');
  await expect(diamond).toBeVisible();

  await page.getByTestId('constraint-influence').hover();
  await page.keyboard.press('i');
  await expect.poll(() => influenceKeys(page).then((k) => k.length)).toBe(1);

  // On the key: a click would take it off. I keeps it.
  await page.keyboard.press('i');
  await page.waitForTimeout(300);
  expect((await influenceKeys(page)).length).toBe(1);

  await setTime(page, 1);
  await diamond.hover();
  await page.keyboard.press('i');
  await expect.poll(() => influenceKeys(page).then((k) => k.map((x) => x.time))).toEqual([0, 1]);
});

test('a row of several fields: I over any of it keys that setting alone', async ({ page }) => {
  await boot(page, false);
  await select(page, 'n_box');
  const diamond = page.getByTestId('inspector-diamond-n_box-position');
  await expect(diamond).toBeVisible();
  const box = (await diamond.boundingBox())!;
  // Down in the row's fields, well away from the diamond.
  await page.mouse.move(box.x + 150, box.y + 30);
  await page.keyboard.press('i');
  await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');
  await expect(page.getByTestId('inspector-diamond-n_box-rotation')).toHaveAttribute(
    'data-anim-state',
    'none',
  );
});

test('something row-sized that is not the row keys nothing: Play is not scene speed', async ({
  page,
}) => {
  await boot(page, true);
  await select(page, 'n_box');
  const speed = page.getByTestId('timebar-speed-diamond');
  await expect(speed).toBeVisible();
  const box = (await page.getByTestId('timebar').boundingBox())!;
  // The timebar holds one diamond and is one row tall; its far end is not on that setting.
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.keyboard.press('i');
  await page.waitForTimeout(300);
  await expect(speed).toHaveAttribute('data-anim-state', 'none');

  // Control: on its own label the same diamond does take the key.
  await speed.hover();
  await page.keyboard.press('i');
  await expect(speed).not.toHaveAttribute('data-anim-state', 'none');
});

test('a section header with one keyable setting under it is not that setting', async ({ page }) => {
  await boot(page, false);
  await select(page, 'n_box');
  const size = page.getByTestId('inspector-diamond-n_box_data-size');
  await expect(size).toBeVisible();
  const box = (await page.getByTestId('inspector-section-mesh').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.keyboard.press('i');
  await page.waitForTimeout(300);
  await expect(size).toHaveAttribute('data-anim-state', 'none');
});

test('off every row: the selection rule stands, and a press that keys nothing says so', async ({
  page,
}) => {
  await boot(page, true);
  await page.mouse.move(5, 5);

  // Control: the selected object keys its transform.
  await select(page, 'n_box');
  const before = await keyCount(page);
  await page.keyboard.press('i');
  await expect.poll(() => keyCount(page)).toBe(before + 3);

  // A compute node has no transform to key.
  await select(page, 'e_f');
  const still = await keyCount(page);
  await page.keyboard.press('i');
  await said(page, 'has no transform to key');
  expect(await keyCount(page)).toBe(still);
});

test('with the timeline closed, off every row, the press says what is missing', async ({
  page,
}) => {
  await boot(page, false);
  await page.mouse.move(5, 5);
  await select(page, 'n_box');
  const before = await keyCount(page);
  await page.keyboard.press('i');
  await said(page, 'Open the timeline to key the selection.');
  expect(await keyCount(page)).toBe(before);
});

test('I over a field with no key says it cannot be keyed', async ({ page }) => {
  await boot(page, false);
  await select(page, 'e_f');
  // The curve name row's field, and the follow row: a field no diamond belongs to.
  const field = page.locator('input[type="text"], select').first();
  await field.hover();
  const before = await keyCount(page);
  await page.keyboard.press('i');
  await said(page, 'This setting cannot be keyed.');
  expect(await keyCount(page)).toBe(before);
});
