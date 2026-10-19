// #1675 — the Graph editor space, against the REAL app: View ▸ Editor Space ▸ Graph draws the live
// scene as nodes, a node clicked there is selected in the app (the inspector shows it), a node
// selected in the app is marked in the graph, and Tab leaves the Graph for the 3D View, unmounting it. Unwiring the
// menu item, the slot, or the selection hand-off drops one of these assertions.

import { expect, test } from './_fixtures';

interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, unknown> } } };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
});

test('View ▸ Editor Space ▸ Graph draws the scene and shares the selection', async ({ page }) => {
  const layout = page.getByTestId('layout');
  await page.getByTestId('menu-view-button').click();
  await page.getByTestId('menu-view-space').hover();
  await page.getByTestId('menu-view-space-graph').click();
  await expect(layout).toHaveAttribute('data-space', 'graph');
  await expect(page.getByTestId('graph-view')).toBeVisible();

  // Every node of the starter scene is drawn (nothing in it is hidden).
  const total = await page.evaluate(
    () => Object.keys((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).length,
  );
  expect(total).toBeGreaterThan(0);
  await expect(page.locator('[data-graph-node]')).toHaveCount(total);
  await expect(page.getByTestId('graph-view-counts')).toContainText(`${total} nodes`);

  // Graph → app: clicking the camera node selects it in the app.
  const camera = page.locator('[data-graph-node="n_camera"]');
  await camera.locator('rect').first().click({ force: true });
  await expect(camera).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('graph-slot')).toBeVisible();
  const selected = await page.evaluate(async () => {
    const m = await import('/src/app/stores/selectionStore.ts');
    return m.useSelectionStore.getState().primaryNodeId;
  });
  expect(selected).toBe('n_camera');

  // App → graph: selecting the light elsewhere moves the mark.
  await page.evaluate(async () => {
    const m = await import('/src/app/stores/selectionStore.ts');
    m.useSelectionStore.getState().select('n_light');
  });
  await expect(page.locator('[data-graph-node="n_light"]')).toHaveAttribute(
    'data-selected',
    'true',
  );
  await expect(camera).not.toHaveAttribute('data-selected', 'true');

  // Tab is not a road into the Graph, but it is a road out.
  await page.getByTestId('graph-view-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Tab');
  await expect(layout).toHaveAttribute('data-space', 'view3d');

  // Both buttons are roads in: the switcher at the top right and the toolbar.
  await page.getByTestId('space-switch-graph').click();
  await expect(layout).toHaveAttribute('data-space', 'graph');
  await expect(page.getByTestId('graph-view')).toBeVisible();
  await page.getByTestId('toolbar-space-view3d').click();
  await expect(layout).toHaveAttribute('data-space', 'view3d');
  await page.getByTestId('toolbar-space-graph').click();
  await expect(layout).toHaveAttribute('data-space', 'graph');

  await page.getByTestId('graph-view-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Tab');
  await expect(layout).toHaveAttribute('data-space', 'view3d');
  // Closed, the graph is not mounted at all, so it does no work while the 3D View is up.
  await expect(page.getByTestId('graph-view')).toHaveCount(0);
});

// #1563 — one level at a time. A Solver's sub-network is drawn inside it, not beside it:
// double-clicking the Solver goes in, the path bar comes back out, and every node sits where
// the graph's own layout (`layoutOf`) puts it.
test('a sub-network is its own level: double-click goes in, the path bar comes out', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { rawSpringOps } = await import('/src/test-utils/rawSpring.ts');
    const dag = (window as unknown as DagWindow).__basher_dag as unknown as {
      getState: () => {
        state: Parameters<typeof rawSpringOps>[0];
        dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
      };
    };
    const state = dag.getState().state;
    dag.getState().dispatchAtomic(
      rawSpringOps(state, {
        targetId: 'n_box',
        controllerId: 'n_light',
        idFor: (k: string) => `s_${k}`,
      }),
      'user',
      'spring',
    );
    // And a key on the camera's position, through the inspector's own road.
    const { dispatchFirstKeyComposite } = await import('/src/app/animate/dispatchMutator.ts');
    const keyed = dispatchFirstKeyComposite({
      targetId: 'n_camera',
      paramPath: 'position',
      value: [0, 2, 8],
      seconds: 0,
    });
    if (!keyed.ok) throw new Error(keyed.reason);
  });
  await page.getByTestId('space-switch-graph').click();
  const solver = page.locator('[data-graph-node="s_solver"]');
  await expect(solver).toBeVisible();

  // The camera's keys act only on its position: hidden until asked for, and the row they drive
  // is tinted instead. Asked for, they are a node again. The driver is fed by the Solver's
  // wire, so it is drawn either way.
  const channel = page.locator('[data-graph-node^="n_camera"][data-graph-node*="position"]');
  await expect(channel).toHaveCount(0);
  await expect(page.locator('[data-graph-node="s_driver"]')).toHaveCount(1);
  await expect(
    page.locator('[data-graph-node="n_camera"] [data-graph-tint="position:KeyframeChannelVec3"]'),
  ).toHaveCount(1);
  await page.getByTestId('graph-view-show-animation').check();
  await expect(channel).toHaveCount(1);
  await expect(page.locator('[data-graph-tint]')).toHaveCount(0);
  // Reference lines: all of them, only the selected node's, or none. Wires always draw.
  const refLines = page.locator('[data-graph-line^="ref:"]');
  const wireLines = page.locator('[data-graph-line^="wire:"]');
  const wiresDrawn = await wireLines.count();
  await expect(refLines).not.toHaveCount(0);
  await page.getByTestId('graph-view-ref-lines').selectOption('none');
  await expect(refLines).toHaveCount(0);
  await expect(wireLines).toHaveCount(wiresDrawn);
  await page.getByTestId('graph-view-ref-lines').selectOption('selected');
  await expect(refLines).toHaveCount(0);
  await page.evaluate(async () => {
    const m = await import('/src/app/stores/selectionStore.ts');
    m.useSelectionStore.getState().select('s_driver');
  });
  await expect(page.locator('[data-graph-line="ref:s_driver>n_box"]')).toHaveCount(1);
  await page.getByTestId('graph-view-ref-lines').selectOption('all');
  // The scene and render outputs are flags on their nodes.
  await expect(page.locator('[data-graph-node="n_scene"] [data-graph-badges]')).toHaveAttribute(
    'data-graph-badges',
    /SCENE/,
  );
  const inside = Number(
    await solver.locator('[data-graph-inside]').getAttribute('data-graph-inside'),
  );
  expect(inside).toBeGreaterThan(3);
  const total = await page.evaluate(
    () => Object.keys((window as unknown as DagWindow).__basher_dag!.getState().state.nodes).length,
  );
  await expect(page.locator('[data-graph-node]')).toHaveCount(total - inside);

  await solver.locator('rect').first().dblclick({ force: true });
  await expect(page.getByTestId('graph-view-path-s_solver')).toBeVisible();
  await expect(page.locator('[data-graph-node]')).toHaveCount(inside);
  await expect(solver).toHaveCount(0);

  // Each node is drawn where the graph places it: the view adds no layout of its own.
  const drawn = await page.locator('[data-graph-node]').evaluateAll((els) =>
    els.map((el) => {
      const m = /translate\(([-\d.e]+),([-\d.e]+)\)/.exec(el.getAttribute('transform') ?? '')!;
      return [el.getAttribute('data-graph-node')!, Number(m[1]), Number(m[2])] as const;
    }),
  );
  const placed = await page.evaluate(
    async (ids) => {
      const { layoutOf } = await import('/src/core/dag/layout.ts');
      const at = layoutOf((window as unknown as DagWindow).__basher_dag!.getState().state as never);
      return ids.map((id) => at.get(id));
    },
    drawn.map((d) => d[0]),
  );
  expect(drawn.map((d) => [d[1], d[2]])).toEqual(placed);

  await page.getByTestId('graph-view-path-top').click();
  await expect(page.getByTestId('graph-view-path-s_solver')).toHaveCount(0);
  await expect(page.locator('[data-graph-node]')).toHaveCount(total - inside);
});
