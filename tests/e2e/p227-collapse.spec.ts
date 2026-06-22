// #227 Slice 5(a) — generalize outliner collapse to Group / Transform /
// MaterialOverride wrappers (previously glTF assets only). These containers
// default EXPANDED (the user's own small hierarchies, not a glTF node-flood),
// and their chevron cuts the whole nested subtree. Collapse is pure UI state —
// it never mutates the DAG (the rows still exist, only the projection hides them).

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
}

const ready = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), { timeout: 15000 });

test('a Group collapses its nested children and defaults to expanded', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_grp',
          nodeType: 'Group',
          params: { position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        { type: 'connect', from: { node: 'n_grp', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'disconnect', from: { node: 'n_box', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'connect', from: { node: 'n_box', socket: 'out' }, to: { node: 'n_grp', socket: 'children' } },
      ],
      'user',
      'group the box',
    );
  });

  // Default-EXPANDED: the nested box row is visible, the Group's chevron is open.
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  await expect(page.getByTestId('scene-tree-row-n_grp')).toHaveAttribute('data-expanded', 'true');

  // Collapse the Group → the nested box row is cut from the projection.
  await page.getByTestId('scene-tree-toggle-n_grp').click();
  await expect(page.getByTestId('scene-tree-row-n_grp')).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByTestId('scene-tree-row-n_box')).toHaveCount(0);

  // Expand again → the child returns. The DAG never changed (box still nested).
  await page.getByTestId('scene-tree-toggle-n_grp').click();
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
});

test('a Transform wrapper collapses its single target', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    // Wrap n_box in a Transform: Scene → Transform(target=n_box).
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_xf',
          nodeType: 'Transform',
          params: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        { type: 'disconnect', from: { node: 'n_box', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'connect', from: { node: 'n_box', socket: 'out' }, to: { node: 'n_xf', socket: 'target' } },
        { type: 'connect', from: { node: 'n_xf', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
      ],
      'user',
      'wrap the box',
    );
  });

  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  await page.getByTestId('scene-tree-toggle-n_xf').click();
  await expect(page.getByTestId('scene-tree-row-n_box')).toHaveCount(0);
});
