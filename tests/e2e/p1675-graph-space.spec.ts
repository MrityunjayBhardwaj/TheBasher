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
  // Closed, the graph is not mounted at all, so it does no work while the 3D View is up.
  await expect(page.getByTestId('graph-view')).toHaveCount(0);
});
