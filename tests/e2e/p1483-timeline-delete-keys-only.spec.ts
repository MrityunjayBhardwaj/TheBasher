// #1483 — with the pointer over the timeline, Delete deletes keys and never the selected object.
//
// Measured before the fix (2026-10-04): a cube with a keyed position channel, the box selected,
// the curve editor hovered. Delete with a key selected removed the key and cleared the key
// selection; Delete again removed the nodes ["n_audit2_pos", "n_box_data"] — the channel and the
// box. The key-delete branch fell through to the node delete whenever it had no key to delete.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_viewport: { getState: () => { setTimelineDrawerOpen: (v: boolean) => void } };
  __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_timeline_selection: {
    getState: () => {
      setActiveChannel: (id: string | null) => void;
      setActiveKeyframe: (ref: { channelId: string; time: number } | null) => void;
    };
  };
}

const CH = 'n_p1483_pos';

async function seed(page: Page, keys: { time: number; value: number[] }[]) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const box = await page.evaluate(
    async ({ ch, keys }) => {
      const w = window as unknown as W;
      const dag = w.__basher_dag.getState();
      const box = Object.entries(dag.state.nodes).find(([, n]) => n.type === 'BoxData')![0];
      const keyframes = keys.map((k) => ({ ...k, easing: 'linear' }));
      dag.dispatchAtomic(
        [
          dag.state.nodes[ch]
            ? { type: 'setParam', nodeId: ch, paramPath: 'keyframes', value: keyframes }
            : {
                type: 'addNode',
                nodeId: ch,
                nodeType: 'KeyframeChannelVec3',
                params: { name: 'pos', target: box, paramPath: 'position', keyframes },
              },
        ],
        'user',
        'seed',
      );
      const s = await import('/src/app/stores/selectionStore.ts');
      s.useSelectionStore.getState().select(box);
      w.__basher_viewport.getState().setTimelineDrawerOpen(true);
      w.__basher_timeline_dock.getState().setActiveTab('curve');
      w.__basher_timeline_selection.getState().setActiveChannel(ch);
      return box;
    },
    { ch: CH, keys },
  );
  await expect(page.getByTestId('curve-editor').first()).toBeVisible();
  return box;
}

const present = (page: Page, ids: string[]) =>
  page.evaluate(
    (ids) => ids.filter((id) => (window as unknown as W).__basher_dag.getState().state.nodes[id]),
    ids,
  );
const keyTimes = (page: Page) =>
  page.evaluate(
    (ch) =>
      (
        (window as unknown as W).__basher_dag.getState().state.nodes[ch]?.params.keyframes as
          | { time: number }[]
          | undefined
      )?.map((k) => k.time) ?? null,
    CH,
  );
const selectKey = (page: Page, time: number) =>
  page.evaluate(
    ({ ch, time }) =>
      (window as unknown as W).__basher_timeline_selection
        .getState()
        .setActiveKeyframe({ channelId: ch, time }),
    { ch: CH, time },
  );
async function hoverCurve(page: Page) {
  const b = (await page.getByTestId('curve-editor').first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

test('Delete twice over the curve editor deletes one key, then nothing, and says why', async ({
  page,
}) => {
  const box = await seed(page, [
    { time: 0, value: [0, 0, 0] },
    { time: 1, value: [2, 1, -1] },
    { time: 2, value: [0, 0, 0] },
  ]);
  await selectKey(page, 1);
  await hoverCurve(page);
  await page.keyboard.press('Delete');
  expect(await keyTimes(page)).toEqual([0, 2]);

  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  expect(await present(page, [CH, box]), 'the channel and the box are still there').toEqual([
    CH,
    box,
  ]);
  expect(await keyTimes(page)).toEqual([0, 2]);
  await expect(page.getByTestId('toast-info')).toContainText('No key selected to delete');
});

test('Delete on a channel’s last key, over the timeline, keeps it and says why', async ({
  page,
}) => {
  const box = await seed(page, [{ time: 1, value: [2, 1, -1] }]);
  await selectKey(page, 1);
  await hoverCurve(page);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  expect(await present(page, [CH, box])).toEqual([CH, box]);
  expect(await keyTimes(page)).toEqual([1]);
  await expect(page.getByTestId('toast-info')).toContainText('keeps its last key');
});

test('with the pointer over the 3D view, Delete still deletes the selected object', async ({
  page,
}) => {
  const box = await seed(page, [
    { time: 0, value: [0, 0, 0] },
    { time: 1, value: [2, 1, -1] },
  ]);
  // The control: the timeline is open but the pointer is over the viewport and no key is
  // selected, so Delete is the 3D view's.
  await page.mouse.move(700, 300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  expect(await present(page, [box])).toEqual([]);
});
