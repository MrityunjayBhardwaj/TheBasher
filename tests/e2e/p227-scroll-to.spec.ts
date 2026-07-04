// #227 Slice 5(b) — scroll-to / expand-to the active row. When the active node
// changes (e.g. a viewport pick of a node nested under a collapsed container),
// the outliner auto-expands every collapsed ancestor so the row surfaces, then
// scrolls it into view. Expanding is the testable behavioral piece (scrollIntoView
// is a best-effort DOM call). Selection is a UI projection — no DAG mutation.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
}

test('selecting a node hidden under a collapsed Group expands the ancestor', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
    timeout: 15000,
  });

  await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_grp',
          nodeType: 'Group',
          params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        {
          type: 'connect',
          from: { node: 'n_grp', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_grp', socket: 'children' },
        },
      ],
      'user',
      'group the box',
    );
  });

  // Collapse the Group → box hidden.
  await page.getByTestId('scene-tree-toggle-n_grp').click();
  await expect(page.getByTestId('scene-tree-row-n_box')).toHaveCount(0);

  // Select the hidden box (simulating a viewport pick).
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().select('n_box'));

  // The ancestor Group auto-expands and the box row surfaces + becomes active.
  await expect(page.getByTestId('scene-tree-row-n_grp')).toHaveAttribute('data-expanded', 'true');
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  await expect(page.getByTestId('scene-tree-row-n_box')).toHaveAttribute('data-active', 'true');
});
