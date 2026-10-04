// #397 — Move to Collection (M), as Blender 5.1.1 does it (observed headless,
// `object.move_to_collection`): the object leaves every collection and joins the one chosen alone;
// to the Scene Collection it leaves them all; a new collection is made and holds it. Through the
// product's own doors: the outliner's New Collection, Shift+A ▸ Cube, M and its menu, and the
// collection's eye — which must reach a NESTED member too (an imported file's child Object).
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface O3 {
  name?: string;
  isMesh?: boolean;
  userData?: Record<string, unknown>;
  traverse: (f: (o: O3) => void) => void;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          { id: string; type: string; inputs: Record<string, unknown>; meta?: { name?: string } }
        >;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three?: { getState: () => { scene: O3 | null } };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

const nodeIds = (page: Page) =>
  page.evaluate(() => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes));

/** Which collections hold `id`, by name, sorted. */
const collectionsOf = (page: Page, id: string) =>
  page.evaluate((target) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return Object.values(nodes)
      .filter((n) => n.type === 'Collection')
      .filter((n) => {
        const v = n.inputs.members;
        const refs = (Array.isArray(v) ? v : v ? [v] : []) as { node: string }[];
        return refs.some((r) => r.node === target);
      })
      .map((n) => n.meta?.name ?? n.id)
      .sort();
  }, id);

/** Whether three draws `id`: a top-level node by its name, a nested one by its identity group. */
const isDrawn = (page: Page, id: string) =>
  page.evaluate((target) => {
    const scene = (window as unknown as W).__basher_three?.getState().scene;
    let found = false;
    scene?.traverse((o) => {
      if (o.name === target || o.userData?.basherNodeId === target) found = true;
    });
    return found;
  }, id);

async function newCollection(page: Page): Promise<string> {
  const before = new Set(await nodeIds(page));
  await page
    .locator('[data-testid^="scene-tree-row-"][data-depth="0"]')
    .first()
    .click({ button: 'right' });
  await page.getByTestId('outliner-ctx-new-collection').click();
  await expect.poll(async () => (await nodeIds(page)).length).toBe(before.size + 1);
  return (await nodeIds(page)).find((id) => !before.has(id))!;
}

async function pressM(page: Page) {
  await page.locator('canvas').first().hover();
  await page.keyboard.press('m');
  await expect(page.getByTestId('move-to-collection-menu')).toBeVisible();
}

test('#397 — M moves the selection to a collection, a new one, and back to the scene', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });

  const col = await newCollection(page);
  const colName = await page.evaluate(
    (id) => (window as unknown as W).__basher_dag.getState().state.nodes[id].meta?.name,
    col,
  );

  // Shift+A ▸ Mesh ▸ Cube, with the scene itself active: the cube joins no collection.
  const beforeAdd = new Set(await nodeIds(page));
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-mesh').click();
  await page.getByTestId('add-menu-item-Cube').click();
  await expect.poll(async () => (await nodeIds(page)).length).toBeGreaterThan(beforeAdd.size);
  const cube = await page.evaluate(
    (before) =>
      Object.values((window as unknown as W).__basher_dag.getState().state.nodes).find(
        (n) => !before.includes(n.id) && n.type === 'Object',
      )!.id,
    [...beforeAdd],
  );
  expect(await collectionsOf(page, cube)).toEqual([]);

  // M lists the Scene Collection, the collection, and New Collection.
  await pressM(page);
  await expect(page.getByTestId('move-to-collection-scene')).toHaveText('Scene Collection');
  await expect(page.getByTestId(`move-to-collection-${col}`)).toHaveText(colName!);
  await page.getByTestId(`move-to-collection-${col}`).click();
  await expect(page.getByTestId('move-to-collection-menu')).toHaveCount(0);
  await expect.poll(() => collectionsOf(page, cube)).toEqual([colName]);
  await expect(page.getByTestId('toast-success').last()).toContainText(`moved to ${colName}`);

  // To a new collection: it holds the cube alone; the first lets it go.
  await pressM(page);
  await page.getByTestId('move-to-collection-new').click();
  await expect.poll(() => collectionsOf(page, cube)).toEqual(['Collection.001']);

  // To the Scene Collection: in none.
  await pressM(page);
  await page.getByTestId('move-to-collection-scene').click();
  await expect.poll(() => collectionsOf(page, cube)).toEqual([]);

  // Esc closes the menu and keeps the selection it would have moved.
  await pressM(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('move-to-collection-menu')).toHaveCount(0);
  await pressM(page);
  await page.getByTestId(`move-to-collection-${col}`).click();
  await expect.poll(() => collectionsOf(page, cube)).toEqual([colName]);

  // The collection's eye takes the moved cube off the screen.
  await expect.poll(() => isDrawn(page, cube)).toBe(true);
  await page.getByTestId(`scene-tree-eye-${col}`).click();
  await expect.poll(() => isDrawn(page, cube), { message: 'the collection hidden' }).toBe(false);
  expect(errors).toEqual([]);
});

test('#397 — a nested object moved into a collection hides with it, and its parent stays', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_ingestGltfFolder));

  // nested-cube.gltf: an empty "Pivot" at the top, the Cube Object under it.
  const before = new Set(await nodeIds(page));
  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await fetch('/assets/nested-cube.gltf').then((r) => r.arrayBuffer()),
    );
    await (window as unknown as W).__basher_ingestGltfFolder!(
      [{ relativePath: 'nested-cube.gltf', bytes }],
      'p397',
    );
  });
  await expect.poll(async () => (await nodeIds(page)).length).toBeGreaterThan(before.size);
  const shape = await page.evaluate(
    (prior) => {
      const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
      const all = Object.values(nodes).filter((n) => !prior.includes(n.id));
      const kids = (n: (typeof all)[number]) => {
        const v = n.inputs.children;
        return (Array.isArray(v) ? v : v ? [v] : []).map((r: { node: string }) => r.node);
      };
      const child = all.find((n) => n.type === 'Object' && n.inputs.data)!;
      const parent = Object.values(nodes).find((n) => kids(n).includes(child.id))!;
      return { child: child.id, parent: parent.id, parentType: parent.type };
    },
    [...before],
  );
  expect(shape.parentType, 'the premise: the child hangs under the file’s own root').not.toBe(
    'Scene',
  );
  await expect.poll(() => isDrawn(page, shape.child)).toBe(true);

  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection.getState().select(id),
    shape.child,
  );
  await pressM(page);
  await page.getByTestId('move-to-collection-new').click();
  await expect.poll(() => collectionsOf(page, shape.child)).toEqual(['Collection']);
  expect(await collectionsOf(page, shape.parent)).toEqual([]);

  const col = await page.evaluate(
    () =>
      Object.values((window as unknown as W).__basher_dag.getState().state.nodes).find(
        (n) => n.type === 'Collection',
      )!.id,
  );
  await page.getByTestId(`scene-tree-eye-${col}`).click();
  await expect
    .poll(() => isDrawn(page, shape.child), { message: 'the nested member hidden' })
    .toBe(false);
  expect(await isDrawn(page, shape.parent), 'its parent is in no collection and stays').toBe(true);
  expect(errors).toEqual([]);
});
