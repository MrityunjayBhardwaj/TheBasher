// Object↔data split — the render-parity + posability e2e (#362 Phase 2, #365 Phase 5a).
//
// Drives the REAL Add ▸ Mesh ▸ Cube affordance (H165 — a test that reaches past the affordance
// cannot test it) and proves, on the pixel side, what the unit tests pin at the value side
// (objectDataReadRoads / objectDataSplit / migrations):
//   - the menu creates the split pair (an Object + a BoxData);
//   - the Object RENDERS (its named group is mounted → world position resolves);
//   - the Object is GIZMO-POSABLE (selected on add → __basher_gizmo_grab installed);
//   - render parity: its rendered world BOUNDS are a unit box (1×1×1) — the split builds the
//     SAME geometry handle a fused box did, so the drawn box is correct.
//
// #365 Phase 5a (Slice 1b): "Cube" IS the split now (the separate "Object (Box)" scaffold item
// is gone). The read-path byte-identity of the migration (fused BoxMesh → this same pair) is
// proven in src/core/project/migrations.test.ts; this is the render-path complement — value
// parity ≠ render parity, so both are proven.

import { expect, test } from './_fixtures';

type V3 = [number, number, number];
interface UiWindow {
  __basher_dag: { getState(): { state: { nodes: Record<string, { type: string }> } } };
  __basher_mesh_world_position?: (id: string) => V3 | null;
  __basher_mesh_world_bounds?: (id: string) => V3 | null;
  __basher_mesh_material?: (id: string) => { color: string | null; type: string | null } | null;
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

test('Add ▸ Cube creates a split pair that renders + poses + draws a unit box', async ({
  page,
}) => {
  await boot(page);

  // The real affordance creates the Object (the pose half); a BoxData (the data half) rides
  // with it — the split is invisible to the director, who just picked "Cube".
  const objId = await addMeshItem(page, 'Cube', 'Object');
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

  // RENDER PARITY: the Object's rendered world bounds are a unit box (1×1×1) — the split
  // resolves the SAME geometry handle a fused box built, so the drawn box is correct. (The
  // fused-vs-split byte-identity is proven read-side in migrations.test.ts.)
  const objBounds = await page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_mesh_world_bounds?.(id) ?? null,
    objId,
  );
  expect(objBounds, 'the Object must report rendered bounds').toBeTruthy();
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(objBounds![i] - 1), 'the split Object renders a unit box (1×1×1)').toBeLessThan(
      1e-6,
    );
  }

  // MATERIAL SURVIVES THE SPLIT (the render-path question, #365 Phase 5a): the material lives
  // on the BoxData half, reached through the Object's `data` edge. Confirm the RENDERED mesh
  // (SceneFromDAG, not just the resolver) carries the OpenPBR material — a MeshPhysicalMaterial
  // whose color is the green default (#5af07a → green-dominant after three's sRGB handling),
  // NOT a null/fallback. Proves SceneFromDAG gives the split mesh its data-half material.
  const mat = await page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_mesh_material?.(id) ?? null,
    objId,
  );
  expect(mat, 'the split Object must render with a material').toBeTruthy();
  expect(mat!.type, 'the OpenPBR IR compiles to a MeshPhysicalMaterial').toBe(
    'MeshPhysicalMaterial',
  );
  expect(mat!.color, 'the material carries a color (not a null fallback)').toBeTruthy();
  const hex = mat!.color!.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((o) => parseInt(hex.slice(o, o + 2), 16));
  expect(g, 'the box keeps its green default — green channel dominates').toBeGreaterThan(r);
  expect(g, 'the box keeps its green default — green channel dominates').toBeGreaterThan(b);
});
