// #397 — nested collections, through the product's own doors, as Blender 5.1.1 has them (measured
// headless, 2026-10-05): the outliner's New Collection nests in the active collection; Add lands in
// a nested active collection; the parent's eye hides what the nested one holds, its own eye on; M
// lists the nested one under its parent; and Delete hands the nested one's objects to the parent
// (`BKE_collection_delete`, `hierarchy == false`).
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface O3 {
  name?: string;
  isMesh?: boolean;
  userData?: Record<string, unknown>;
  traverse: (f: (o: O3) => void) => void;
  traverseVisible: (f: (o: O3) => void) => void;
  parent?: O3 | null;
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

/**
 * Whether the viewport draws `id`. Its own meshes are those under its name (a top-level node) or
 * its identity group (a nested one), not inside another node's identity group. A node with a body
 * is drawn when one of its own meshes is visible all the way up: a body the render alone shows
 * stays mounted, invisible (#1503). A node with no body of its own (an empty) is drawn when its
 * group is.
 */
const isDrawn = (page: Page, id: string) =>
  page.evaluate((target) => {
    type O = O3 & { visible: boolean; isMesh?: boolean; parent?: O | null };
    const scene = (window as unknown as W).__basher_three?.getState().scene as O | null | undefined;
    const shown = (o: O | null | undefined) => {
      for (let p = o; p; p = p.parent) if (!p.visible) return false;
      return true;
    };
    let node: O | null = null;
    let own = 0;
    let ownShown = 0;
    scene?.traverse((o: O) => {
      if (!node && (o.name === target || o.userData?.basherNodeId === target)) node = o;
      if (!o.isMesh) return;
      for (let p: O | null | undefined = o; p; p = p.parent) {
        const tag = p.userData?.basherNodeId;
        if (tag === target || p.name === target) {
          own++;
          if (shown(o)) ownShown++;
          break;
        }
        if (typeof tag === 'string') break;
      }
    });
    return own > 0 ? ownShown > 0 : node !== null && shown(node);
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

test('#397 — a collection nests in the active one, and its parent hides what it holds', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });

  // P in the scene; then, with P active, C — which nests in P.
  const parent = await newCollection(page);
  await page.getByTestId(`scene-tree-row-${parent}`).click();
  const nested = await newCollection(page);
  await expect(page.getByTestId(`scene-tree-row-${parent}`)).toHaveAttribute('data-depth', '1');
  await expect(page.getByTestId(`scene-tree-row-${nested}`)).toHaveAttribute('data-depth', '2');

  // With C active, Shift+A ▸ Cube lands in C, listed under it.
  await page.getByTestId(`scene-tree-row-${nested}`).click();
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
  const names = await page.evaluate(
    (ids) =>
      ids.map((id) => (window as unknown as W).__basher_dag.getState().state.nodes[id].meta?.name),
    [parent, nested],
  );
  expect(await collectionsOf(page, cube)).toEqual([names[1]]);
  await expect(page.getByTestId(`scene-tree-row-${cube}`)).toHaveAttribute('data-depth', '3');

  // The parent's eye hides the cube, the nested collection's own eye still on; and back.
  await expect.poll(() => isDrawn(page, cube)).toBe(true);
  await page.getByTestId(`scene-tree-eye-${parent}`).click();
  await expect.poll(() => isDrawn(page, cube), { message: 'the parent hidden' }).toBe(false);
  await page.getByTestId(`scene-tree-eye-${parent}`).click();
  await expect.poll(() => isDrawn(page, cube), { message: 'the parent shown' }).toBe(true);

  // M lists the nested collection under its parent, indented past it.
  await page.getByTestId(`scene-tree-row-${cube}`).click();
  await pressM(page);
  const indent = (id: string) =>
    page
      .getByTestId(`move-to-collection-${id}`)
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(await indent(nested)).toBeGreaterThan(await indent(parent));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('move-to-collection-menu')).toHaveCount(0);

  // Delete C: the cube is handed to P, and still drawn.
  await page.getByTestId(`scene-tree-row-${nested}`).click({ button: 'right' });
  await page.getByTestId('outliner-ctx-delete').click();
  await expect.poll(() => collectionsOf(page, cube)).toEqual([names[0]]);
  await expect(page.getByTestId(`scene-tree-row-${cube}`)).toHaveAttribute('data-depth', '2');
  await expect.poll(() => isDrawn(page, cube)).toBe(true);
  expect(errors).toEqual([]);
});
