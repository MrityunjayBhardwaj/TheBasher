// #1453 — what the director adds joins the active collection, as Blender links every object it adds
// (Blender 5.1.1, observed headless: `primitive_cube_add` with a collection active lands in it, and
// `object.duplicate` lands in its source's collections). Through the product's own doors: the
// outliner's New Collection, a click that makes it active, Shift+A ▸ Mesh ▸ Cube, Shift+D, and the
// collection's eye, which takes both cubes off the screen.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string; inputs: Record<string, unknown> }>;
      };
    };
  };
  __basher_three?: {
    getState: () => { scene: { getObjectByName: (n: string) => unknown } | null };
  };
}

const nodeIds = (page: Page) =>
  page.evaluate(() => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes));

const membersOf = (page: Page, id: string) =>
  page.evaluate((cid) => {
    const n = (window as unknown as W).__basher_dag.getState().state.nodes[cid];
    const v = n?.inputs.members;
    return (Array.isArray(v) ? v : v ? [v] : []).map((r: { node: string }) => r.node);
  }, id);

/** Which of `ids` the viewport draws: a top-level scene child is drawn under its own id. */
const drawn = (page: Page, ids: string[]) =>
  page.evaluate(
    (list) =>
      list.filter((id) =>
        (window as unknown as W).__basher_three?.getState().scene?.getObjectByName(id),
      ),
    ids,
  );

test('#1453 — an added cube and its duplicate join the active collection, and its eye hides both', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });

  // New Collection from the outliner's menu, then a click makes it active.
  const before = new Set(await nodeIds(page));
  await page.locator('[data-testid^="scene-tree-row-"][data-depth="0"]').click({ button: 'right' });
  await page.getByTestId('outliner-ctx-new-collection').click();
  await expect.poll(async () => (await nodeIds(page)).length).toBe(before.size + 1);
  const col = (await nodeIds(page)).find((id) => !before.has(id))!;
  await page.getByTestId(`scene-tree-row-${col}`).click();
  await expect(page.getByTestId(`scene-tree-row-${col}`)).toHaveAttribute(
    'data-active-collection',
    'true',
  );

  // Shift+A ▸ Mesh ▸ Cube.
  const beforeAdd = new Set(await nodeIds(page));
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-mesh').click();
  await page.getByTestId('add-menu-item-Cube').click();
  await expect.poll(() => membersOf(page, col)).toHaveLength(1);
  const [cube] = await membersOf(page, col);
  expect(beforeAdd.has(cube), 'the member is the cube just added').toBe(false);
  await expect.poll(() => drawn(page, [cube])).toEqual([cube]);

  // Shift+D on the added cube (the Add selects it): the copy joins the same collection.
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+D');
  await expect.poll(() => membersOf(page, col)).toHaveLength(2);
  const members = await membersOf(page, col);
  await expect.poll(() => drawn(page, members)).toEqual(members);

  // The collection's eye takes both off the screen.
  await page.getByTestId(`scene-tree-eye-${col}`).click();
  await expect.poll(() => drawn(page, members), { message: 'the collection hidden' }).toEqual([]);
  expect(errors).toEqual([]);
});
