// #225 — the selected SET acts as a unit. Part 1: the Inspector multi-state.
// Before #225 selecting N nodes showed the primary identically to selecting 1
// (the set was inert; MULTI_SELECT_SECTIONS was dead). Now N>1 renders an
// "N objects selected" summary + a shared Transform section whose fields edit
// EVERY selected node in ONE atomic op.
//
// Boundary-pair: side A = the shared-field edit (UI), side B = every selected
// node's param in the live DAG — they must match, and one undo reverts all.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: Record<string, { node: string }>;
        nodes: Record<string, { params?: { position?: number[] } }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
      undo: () => void;
    };
  };
  __basher_selection: { getState: () => { selectMany: (ids: string[]) => void } };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as BasherWindow).__basher_dag &&
        (window as unknown as BasherWindow).__basher_selection,
      ),
    { timeout: 15000 },
  );
  // Add a second box at a different x so the shared field is "mixed".
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_box_b',
          nodeType: 'BoxMesh',
          params: { size: [1, 1, 1], position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          type: 'connect',
          from: { node: 'n_box_b', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
      ],
      'user',
      'add second box',
    );
  });
});

test('N selected → shared edit sets the value on all and undo reverts the batch', async ({
  page,
}) => {
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_selection
      .getState()
      .selectMany(['n_box', 'n_box_b']),
  );

  await expect(page.locator('[data-testid="inspector-multi-count"]')).toHaveText(
    '2 objects selected',
  );

  // x differs (0 vs 3) → mixed; y/z agree (0) → concrete value.
  const x = page.locator('[aria-label="Position X (all selected)"]');
  await expect(x).toHaveAttribute('placeholder', '—');
  await expect(page.locator('[aria-label="Position Y (all selected)"]')).toHaveValue('0');

  await x.fill('7');
  await x.press('Enter');

  const xs = await page.evaluate(() => {
    const n = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    return [n['n_box'].params!.position![0], n['n_box_b'].params!.position![0]];
  });
  expect(xs).toEqual([7, 7]);

  // ONE undo reverts BOTH nodes (single atomic batch).
  await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag.getState().undo());
  const reverted = await page.evaluate(() => {
    const n = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    return [n['n_box'].params!.position![0], n['n_box_b'].params!.position![0]];
  });
  expect(reverted).toEqual([0, 3]);
});
