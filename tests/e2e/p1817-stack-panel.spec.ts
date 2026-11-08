// #1817 — the Transform Stack card in the running app. A chain built, blended, reordered and cut
// through the stack panel moves the object the viewport draws, and a refused edit says why.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

type V3 = [number, number, number];
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
      dispatch: (op: unknown, source: string, description: string) => void;
      undo: () => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_mesh_world_position: (id: string) => number[] | null;
}

async function boot(page: Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(
      w.__basher_dag?.getState().state.outputs.scene && w.__basher_mesh_world_position,
    );
  });
}

const expectAt = async (page: Page, id: string, want: V3) =>
  expect
    .poll(
      async () => {
        const got = await page.evaluate(
          (i) => (window as unknown as W).__basher_mesh_world_position(i),
          id,
        );
        return got ? Math.max(...got.map((v, k) => Math.abs(v - want[k]))) : Infinity;
      },
      { message: `${id} drawn at ${want}` },
    )
    .toBeLessThan(0.01);

const select = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as W).__basher_selection.getState().select(i), id);

/** Every row id the panel draws, groups included, top first. */
const allRows = (page: Page) =>
  page
    .getByTestId('transform-stack-panel')
    .locator('[data-testid^="transform-stack-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(20)));

/** The chain's own rows: what the curve group and the influence group hold left out. */
const rowOrder = async (page: Page) =>
  (await allRows(page)).filter(
    (id) => !['e_c', 'e_cd'].includes(id) && !id.includes('_influence_'),
  );

test('the Transform Stack builds, blends, reorders and cuts a chain, and the object follows', async ({
  page,
}) => {
  await boot(page);
  // n_box at its own (0, 4, 0); a line to (10, 0, 0) turned 90° about Z puts it at (-4, 10, 0) at
  // the end of the path, and half way at Blender 5.1.1's (-2, 7, 0) (the #1813 fixture).
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_time.getState().pause();
    w.__basher_time.getState().setTime(0);
    const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
    const d = (op: unknown) => w.__basher_dag.getState().dispatch(op, 'user', 'e2e');
    d({ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [0, 4, 0] });
    d({
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
    });
    d({ type: 'addNode', nodeId: 'e_c', nodeType: 'Object', params: { rotation: [0, 0, 90] } });
    d({
      type: 'connect',
      from: { node: 'e_cd', socket: 'out' },
      to: { node: 'e_c', socket: 'data' },
    });
    d({
      type: 'connect',
      from: { node: 'e_c', socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    });
  });
  await expectAt(page, 'n_box', [0, 4, 0]);

  // The card is on the object, empty, and "+ add" offers the constraints.
  await select(page, 'n_box');
  await page.getByTestId('inspector-section-toggle-stack').click();
  const panel = page.getByTestId('transform-stack-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('transform-stack-empty-n_box-constraints').click();
  await expect(page.getByTestId('transform-stack-offer-TrackTo')).toBeVisible();
  await page.getByTestId('transform-stack-offer-FollowPath').click();
  await expect(page.getByTestId('transform-stack-row-FollowPath_1')).toBeVisible();
  expect(await rowOrder(page)).toEqual(['FollowPath_1', 'n_box_own_world']);

  // Point it at the path: the object goes to the end of it.
  await page.evaluate(() => {
    const d = (op: unknown) =>
      (window as unknown as W).__basher_dag.getState().dispatch(op, 'user', 'e2e');
    d({ type: 'setParam', nodeId: 'FollowPath_1', paramPath: 'curve', value: 'e_c' });
    d({ type: 'setParam', nodeId: 'FollowPath_1', paramPath: 'evalTime', value: 1 });
  });
  await expectAt(page, 'n_box', [-4, 10, 0]);

  // Influence 0.5 through the constraint's own row: half way, and the stack reads it as one row.
  await select(page, 'FollowPath_1');
  const influence = page.getByTestId('constraint-influence-input');
  await influence.scrollIntoViewIfNeeded();
  await influence.fill('0.5');
  await expectAt(page, 'n_box', [-2, 7, 0]);
  await select(page, 'n_box');
  await expect(page.getByTestId('transform-stack-influence-FollowPath_1')).toContainText(
    'influence 0.5',
  );
  expect(await rowOrder(page)).toEqual(['FollowPath_1', 'n_box_own_world']);
  // The blend's six small nodes stay folded; only the Value under "factor" is a row of its own.
  expect((await allRows(page)).filter((id) => id.includes('_influence_'))).toEqual([
    'FollowPath_1_influence_value',
  ]);

  // A Track-To on top through "+", then ▼ moves it under the blended Follow Path.
  await page.getByTestId('transform-stack-row-FollowPath_1').hover();
  await page.getByTestId('transform-stack-add-FollowPath_1').click();
  await page.getByTestId('transform-stack-offer-TrackTo').click();
  expect(await rowOrder(page)).toEqual(['TrackTo_1', 'FollowPath_1', 'n_box_own_world']);
  await page.getByTestId('transform-stack-row-TrackTo_1').hover();
  await page.getByTestId('transform-stack-down-TrackTo_1').click();
  expect(await rowOrder(page)).toEqual(['FollowPath_1', 'TrackTo_1', 'n_box_own_world']);
  await expect(page.getByTestId('transform-stack-influence-FollowPath_1')).toContainText(
    'influence 0.5',
  );
  await expectAt(page, 'n_box', [-2, 7, 0]); // a Track-To aiming at nothing moves nothing

  // The bottom of the chain can't go: the panel says why, and nothing changes.
  await page.getByTestId('transform-stack-row-n_box_own_world').hover();
  await page.getByTestId('transform-stack-remove-n_box_own_world').click();
  await expect(page.getByTestId('transform-stack-notice')).toContainText(
    'bottom of a constraint chain',
  );

  // Mute the Follow Path: the object is back at its own place. Mute again: half way.
  await page.getByTestId('transform-stack-mute-FollowPath_1').click();
  await expectAt(page, 'n_box', [0, 4, 0]);
  await page.getByTestId('transform-stack-mute-FollowPath_1').click();
  await expectAt(page, 'n_box', [-2, 7, 0]);

  // Delete it, blend and all: the object is home, and one undo brings the whole blend back.
  await page.getByTestId('transform-stack-row-FollowPath_1').hover();
  await page.getByTestId('transform-stack-remove-FollowPath_1').click();
  expect(await rowOrder(page)).toEqual(['TrackTo_1', 'n_box_own_world']);
  await expectAt(page, 'n_box', [0, 4, 0]);
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expectAt(page, 'n_box', [-2, 7, 0]);
  expect(await rowOrder(page)).toEqual(['FollowPath_1', 'TrackTo_1', 'n_box_own_world']);

  await page.getByTestId('transform-stack-panel').screenshot({
    path: test.info().outputPath('transform-stack.png'),
  });
});
