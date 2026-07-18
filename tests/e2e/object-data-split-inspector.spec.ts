// Object↔data split — the inspector reach (#365 Phase 5a Slice 1c).
//
// A split cube is an Object (pose) pointing at a BoxData (geometry + material). The Object's
// own inspector shows only transform/constraint/driver; the Mesh + Material sections come from
// the LINKED data node (LinkedDataSections), with edits routed to that node. This drives the
// REAL inspector (H165) and proves a director can still recolour a cube after the split — the
// exact affordance that would otherwise be lost. Complements the agent-side mutator unit tests
// (setMaterialColor/scale/randomize reach the BoxData) with the pixel side.

import { expect, test } from './_fixtures';

type V3 = [number, number, number];
interface UiWindow {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { type: string; inputs?: Record<string, unknown> }> };
    };
  };
  __basher_mesh_material?: (id: string) => { color: string | null; type: string | null } | null;
  __basher_mesh_world_position?: (id: string) => V3 | null;
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

test('recolouring a split cube through the inspector reaches its BoxData and repaints it', async ({
  page,
}) => {
  await boot(page);

  // Add ▸ Mesh ▸ Cube — creates the split pair, auto-selected (the Object).
  const before = await page.evaluate(() =>
    Object.keys((window as unknown as UiWindow).__basher_dag.getState().state.nodes),
  );
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-mesh').click();
  await page.getByTestId('add-menu-item-Cube').click();
  await page.waitForTimeout(400);

  const { objId, dataId } = await page.evaluate((before) => {
    const nodes = (window as unknown as UiWindow).__basher_dag.getState().state.nodes;
    const objId = Object.keys(nodes).find(
      (id) => !before.includes(id) && nodes[id].type === 'Object',
    )!;
    const dataRef = nodes[objId]?.inputs?.data as { node?: string } | undefined;
    return { objId, dataId: dataRef?.node ?? null };
  }, before);
  expect(objId, 'Add ▸ Cube created an Object').toBeTruthy();
  expect(dataId, 'the Object points at a BoxData via `data`').toBeTruthy();

  // The linked-data sections render for the selected Object; expand Material so its hex input
  // is interactable (default-collapsed for a mesh-primary node).
  await expect(page.getByTestId('inspector-linked-data')).toBeVisible();
  const materialSection = page.getByTestId('inspector-section-material');
  if ((await materialSection.getAttribute('data-collapsed')) === 'true') {
    await page.getByTestId('inspector-section-toggle-material').click();
  }

  // Edit the base colour to red through the linked BoxData's material editor.
  const hex = page.getByTestId(`inspector-colorhex-${dataId}-material.base.color`);
  await hex.fill('#ff0000');
  await hex.press('Enter');
  await page.waitForTimeout(300);

  // The RENDERED material (SceneFromDAG) is now red — the edit reached the BoxData and repainted
  // the split cube. Read the mesh's live material colour: red channel now dominates.
  const mat = await page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_mesh_material?.(id) ?? null,
    objId,
  );
  expect(mat, 'the cube still renders with a material').toBeTruthy();
  expect(mat!.color, 'the material carries a colour').toBeTruthy();
  const c = mat!.color!.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((o) => parseInt(c.slice(o, o + 2), 16));
  expect(r, 'the inspector edit repainted the cube red — red dominates').toBeGreaterThan(g);
  expect(r, 'the inspector edit repainted the cube red — red dominates').toBeGreaterThan(b);
});
