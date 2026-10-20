// #1556 — the Spreadsheet space, against the REAL app: View ▸ Editor Space ▸ Spreadsheet shows
// every attribute of the selected mesh, one domain at a time; it follows the selection and the
// graph; and a mesh of tens of thousands of faces draws only the rows on screen. Unwiring the
// menu item, the slot, the selection hand-off or the row window drops one of these assertions.

import { expect, test } from './_fixtures';

interface DagWindow {
  __basher_dag: {
    getState: () => { dispatchAtomic: (ops: unknown[], source: string, label: string) => void };
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
});

const select = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(async (id) => {
    const m = await import('/src/app/stores/selectionStore.ts');
    m.useSelectionStore.getState().select(id);
  }, id);

/** A stored cylinder of `radial` × `rings`, as an import would leave it, with a UV set. */
const storeTube = (
  page: import('@playwright/test').Page,
  radial: number,
  rings: number,
  add: boolean,
) =>
  page.evaluate(
    async ({ radial, rings, add }) => {
      const { cylinderMesh } = await import('/src/test-utils/cylinderMesh.ts');
      const { packMeshData } = await import('/src/app/meshGeometryData.ts');
      const mesh = cylinderMesh({ radius: 1, height: 2, radial, rings });
      const corners = mesh.cornerPoints.length;
      const data = {
        ...mesh,
        cornerLayers: [
          { name: 'UVMap', type: 'float2', data: new Float32Array(corners * 2).fill(0.25) },
        ],
      };
      const dag = (window as unknown as DagWindow).__basher_dag;
      const material = { name: 'tube', base: { color: '#ffffff' } };
      dag.getState().dispatchAtomic(
        add
          ? [
              {
                type: 'addNode',
                nodeId: 'tube_data',
                nodeType: 'PolyMeshData',
                params: { mesh: packMeshData(data as never), material },
              },
              { type: 'addNode', nodeId: 'tube', nodeType: 'Object', params: {} },
              {
                type: 'connect',
                from: { node: 'tube_data', socket: 'out' },
                to: { node: 'tube', socket: 'data' },
              },
              {
                type: 'connect',
                from: { node: 'tube', socket: 'out' },
                to: { node: 'n_scene', socket: 'children' },
              },
            ]
          : [
              {
                type: 'setParam',
                nodeId: 'tube_data',
                paramPath: 'mesh',
                value: packMeshData(data as never),
              },
            ],
        'user',
        'tube',
      );
    },
    { radial, rings, add },
  );

test('View ▸ Editor Space ▸ Spreadsheet shows the selected mesh, follows the graph, and draws only what is on screen', async ({
  page,
}) => {
  await select(page, '');
  await page.getByTestId('menu-view-button').click();
  await page.getByTestId('menu-view-space').hover();
  await page.getByTestId('menu-view-space-sheet').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-space', 'sheet');
  await expect(page.getByTestId('sheet-none')).toHaveText('Select a mesh to see its attributes.');

  // The box: its material assignment per face, its UVs per corner.
  await select(page, 'n_box');
  await expect(page.getByTestId('sheet-name')).toHaveText('n_box');
  await expect(page.getByTestId('sheet-domain-face')).toHaveText('Face 6');
  await page.getByTestId('sheet-domain-corner').click();
  await expect(page.getByTestId('sheet-domain-corner')).toHaveText('Corner 24');
  await expect(page.getByTestId('sheet-col-UVMap.x')).toBeVisible();
  await expect(page.getByTestId('sheet-col-UVMap.y')).toBeVisible();

  // A stored mesh, selected, then edited: the sheet follows the graph.
  await storeTube(page, 8, 3, true);
  await select(page, 'tube');
  await expect(page.getByTestId('sheet-domain-point')).toHaveText('Point 24');
  await expect(page.getByTestId('sheet-domain-face')).toHaveText('Face 16');
  await storeTube(page, 6, 2, false);
  await expect(page.getByTestId('sheet-domain-point')).toHaveText('Point 12');
  await page.getByTestId('sheet-domain-corner').click();
  await expect(page.locator('[data-sheet-row="0"] td').nth(2)).toHaveText('0.250');

  // Tens of thousands of faces: only the rows on screen are drawn, and scrolling moves them.
  await storeTube(page, 200, 101, false);
  await page.getByTestId('sheet-domain-face').click();
  await expect(page.getByTestId('sheet-domain-face')).toHaveText('Face 20,000');
  const drawn = await page.locator('[data-sheet-row]').count();
  expect(drawn).toBeGreaterThan(5);
  expect(drawn).toBeLessThan(120);
  await page.getByTestId('sheet-table').evaluate((el) => (el.scrollTop = 20 * 15_000));
  await expect(page.locator('[data-sheet-row="15000"]')).toBeVisible();
  await expect(page.locator('[data-sheet-row="0"]')).toHaveCount(0);
});
