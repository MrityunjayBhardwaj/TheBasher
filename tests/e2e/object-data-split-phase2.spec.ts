// Object↔data split, Phase 2 (#362) — the render-parity + posability e2e.
//
// Drives the REAL Add ▸ Object (Box) affordance (H165 — a test that reaches past the
// affordance cannot test it) and proves, on the pixel side, what the unit tests pin at
// the value side (objectDataReadRoads / objectDataSplit):
//   - the menu creates the split pair (an Object + a BoxData);
//   - the Object RENDERS (its named group is mounted → world position resolves);
//   - the Object is GIZMO-POSABLE (selected on add → __basher_gizmo_grab installed);
//   - render parity: its rendered world BOUNDS equal a fused Cube's — one geometry
//     handle, one registry build, the same box (the split is byte-identical).
//
// The complement of the Phase-1 value parity: value parity ≠ render parity, so both are
// proven — a unit test for the handle/material, this for the pixels.

import { expect, test } from './_fixtures';

type V3 = [number, number, number];
interface UiWindow {
  __basher_dag: { getState(): { state: { nodes: Record<string, { type: string }> } } };
  __basher_mesh_world_position?: (id: string) => V3 | null;
  __basher_mesh_world_bounds?: (id: string) => V3 | null;
  __basher_gizmo_grab?: (mode: string, target: V3) => void;
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('canvas');
  await page.waitForFunction(() =>
    Boolean((window as unknown as UiWindow).__basher_mesh_world_position),
  );
}

/** Drive the real Add menu for one Mesh-group item, return the created node's id (by type). */
async function addMeshItem(
  page: import('@playwright/test').Page,
  kind: string,
  nodeType: string,
): Promise<string> {
  const before = await page.evaluate(() =>
    Object.keys((window as unknown as UiWindow).__basher_dag.getState().state.nodes),
  );
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-mesh').click();
  await page.getByTestId(`add-menu-item-${kind}`).click();
  await page.waitForTimeout(400);
  const id = await page.evaluate(
    ({ before, nodeType }) => {
      const nodes = (window as unknown as UiWindow).__basher_dag.getState().state.nodes;
      return (
        Object.entries(nodes).find(
          ([nid, n]) => !before.includes(nid) && n.type === nodeType,
        )?.[0] ?? null
      );
    },
    { before, nodeType },
  );
  expect(id, `Add ▸ ${kind} must create a ${nodeType}`).toBeTruthy();
  return id!;
}

test('Add ▸ Object creates a split pair that renders + poses + matches a fused cube', async ({
  page,
}) => {
  await boot(page);

  // The real affordance creates the Object (the pose half); a BoxData (the data half)
  // rides with it.
  const objId = await addMeshItem(page, 'Object', 'Object');
  const types = await page.evaluate(() =>
    Object.values((window as unknown as UiWindow).__basher_dag.getState().state.nodes).map(
      (n) => n.type,
    ),
  );
  expect(types, 'the split pair — an Object wired to a BoxData').toContain('BoxData');

  // It RENDERS: the named group is mounted, so its world position resolves.
  const objWorld = await page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_mesh_world_position?.(id) ?? null,
    objId,
  );
  expect(objWorld, 'the Object must render (named group mounted)').toBeTruthy();

  // It is GIZMO-POSABLE: added-and-selected installs the transform gizmo (getManipulable
  // resolves the Object's position param — "posable" is its type, not a duck-type check).
  const posable = await page.evaluate(() =>
    Boolean((window as unknown as UiWindow).__basher_gizmo_grab),
  );
  expect(posable, 'selecting the Object must install the gizmo').toBe(true);

  // RENDER PARITY: a fused Cube's rendered bounds equal the Object's — the split builds
  // the SAME geometry handle, so the drawn box is byte-identical.
  const cubeId = await addMeshItem(page, 'Cube', 'BoxMesh');
  const [objBounds, cubeBounds] = await page.evaluate(
    ({ objId, cubeId }) => {
      const w = window as unknown as UiWindow;
      return [
        w.__basher_mesh_world_bounds?.(objId) ?? null,
        w.__basher_mesh_world_bounds?.(cubeId) ?? null,
      ];
    },
    { objId, cubeId },
  );
  expect(objBounds, 'the Object must report rendered bounds').toBeTruthy();
  expect(cubeBounds, 'the fused cube must report rendered bounds').toBeTruthy();
  for (let i = 0; i < 3; i++) {
    expect(
      Math.abs(objBounds![i] - cubeBounds![i]),
      'the split Object renders the same box as the fused cube',
    ).toBeLessThan(1e-6);
  }
});
