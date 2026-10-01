// p1130 — a refused Apply says why, on screen, from both Apply surfaces (issue #1130).
//
// `dispatchApplyTransform` refuses with a sentence, and both buttons used to throw it away, so a
// refused click looked like a broken button. The subject here is a real refusal reached through
// the real product: a box holding an ANIMATED child. Apply is offered on the box (it is not
// animated itself), and refused by name at dispatch, because the child's keys would move it back
// as soon as Apply kept it in place (`childCompensation`). The control is the same box holding a
// still child, which bakes: no warning, and the graph changes.
//
// #1053 — this used to stage a clone-road import whose second UV set the baked store could not
// keep. The clone road is retired and a native import's Apply writes into its stored mesh, so that
// refusal is no longer reachable from an import; the animated-child refusal is the one a director
// meets on the bake road now.
//
// Every assertion reads what the director would see (the toast text) plus the graph, never the
// dispatch's return value.
//
// REF: src/app/animate/applyTransformAction.ts; src/app/MenuBar.tsx (Object ▸ Apply);
//      src/app/NPanel.tsx (`ApplyTransformControl`);
//      src/app/animate/dispatchApplyTransform.ts (`childCompensation`); issues #1130, #1185.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCubeOps } from './_splitCube';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string }>; outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_three: { getState: () => { scene: unknown } };
}

const PARENT = 'p1130_parent';
const CHILD = 'p1130_child';

/** A box at the scene root holding a child box; `animated` keys the child's position. Selects the parent. */
async function stageAndSelect(page: Page, animated: boolean): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag?.getState().state.outputs.scene && w.__basher_three?.getState().scene,
    );
  });
  await page.evaluate(
    ({ parentOps, childOps, animated, parent, child }) => {
      const dag = (window as unknown as W).__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...parentOps,
          ...childOps,
          {
            type: 'connect',
            from: { node: parent, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
          {
            type: 'connect',
            from: { node: child, socket: 'out' },
            to: { node: parent, socket: 'children' },
          },
          ...(animated
            ? [
                {
                  type: 'addNode',
                  nodeId: 'p1130_child_kf',
                  nodeType: 'KeyframeChannelVec3',
                  params: {
                    name: 'p1130_child_kf',
                    target: child,
                    paramPath: 'position',
                    keyframes: [
                      { time: 0, value: [2, 0, 0], easing: 'linear' },
                      { time: 2, value: [2, 1, 0], easing: 'linear' },
                    ],
                  },
                },
              ]
            : []),
        ],
        'user',
        'p1130 parent and child',
      );
    },
    {
      parentOps: splitCubeOps({ objectId: PARENT, position: [0, 0, 0], scale: [2, 1, 1] }),
      childOps: splitCubeOps({ objectId: CHILD, position: [2, 0, 0] }),
      animated,
      parent: PARENT,
      child: CHILD,
    },
  );
  await page.evaluate(async (id) => {
    const m = await import('/src/app/stores/selectionStore.ts');
    m.useSelectionStore.getState().select(id);
  }, PARENT);
}

const nodeTypes = (page: Page) =>
  page.evaluate(() =>
    Object.values((window as unknown as W).__basher_dag.getState().state.nodes)
      .map((n) => n.type)
      .sort(),
  );

test.describe('#1130 — a refused Apply is shown, not dropped', () => {
  test('the N panel Apply button shows the refusal and leaves the graph alone', async ({
    page,
  }) => {
    await stageAndSelect(page, true);
    const before = await nodeTypes(page);
    await expect(page.getByTestId('npanel-apply-all')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('npanel-apply-all').click();

    const warning = page.getByTestId('toast-warn');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('which is animated');
    await expect(warning).toContainText('Unparent it first');
    expect(await nodeTypes(page)).toEqual(before);
  });

  test('Object ▸ Apply shows the same refusal', async ({ page }) => {
    await stageAndSelect(page, true);
    const before = await nodeTypes(page);
    await page.getByTestId('menu-object-button').click();
    await page.getByTestId('menu-object-apply').hover();
    await expect(page.getByTestId('menu-object-apply-all')).toBeEnabled();
    await page.getByTestId('menu-object-apply-all').click();

    const warning = page.getByTestId('toast-warn');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('which is animated');
    expect(await nodeTypes(page)).toEqual(before);
  });

  test('control: an Apply that bakes shows no warning and changes the graph', async ({ page }) => {
    await stageAndSelect(page, false);
    const before = await nodeTypes(page);
    await expect(page.getByTestId('npanel-apply-all')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('npanel-apply-all').click();

    await expect.poll(() => nodeTypes(page)).not.toEqual(before);
    expect(await nodeTypes(page)).toContain('BakedData');
    await expect(page.getByTestId('toast-warn')).toHaveCount(0);
    await expect(page.getByTestId('toast-error')).toHaveCount(0);
  });
});
