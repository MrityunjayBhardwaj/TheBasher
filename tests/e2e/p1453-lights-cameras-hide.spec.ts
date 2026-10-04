// #1453 — a light and a camera are scene objects like any other: the outliner's eye hides each,
// the Add menu and M put each into a collection, and a hidden collection hides them. What the app
// draws is read off the live scene: the lights three holds (a hidden one lights nothing, in the
// viewport and the render alike) and the frustums the viewport draws (`__basher_frustum_pose`,
// dropped when a frustum unmounts).
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; inputs: Record<string, unknown> }>;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_light_world_positions: () => [number, number, number][];
  __basher_frustum_pose?: Record<string, unknown>;
}

const nodeIds = (page: Page) =>
  page.evaluate(() => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes));
const lightCount = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_light_world_positions().length);
const hasFrustum = (page: Page, id: string) =>
  page.evaluate((cam) => Boolean((window as unknown as W).__basher_frustum_pose?.[cam]), id);

/** The Objects posing the given data type, in the graph's order. */
const objectsOver = (page: Page, dataType: string) =>
  page.evaluate((t) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return Object.values(nodes)
      .filter((n) => {
        const d = n.inputs.data as { node?: string } | undefined;
        return n.type === 'Object' && d?.node !== undefined && nodes[d.node]?.type === t;
      })
      .map((n) => n.id);
  }, dataType);

const membersOf = (page: Page, id: string) =>
  page.evaluate((cid) => {
    const v = (window as unknown as W).__basher_dag.getState().state.nodes[cid]?.inputs.members;
    return (Array.isArray(v) ? v : v ? [v] : []).map((r: { node: string }) => r.node);
  }, id);

async function newActiveCollection(page: Page): Promise<string> {
  const before = new Set(await nodeIds(page));
  await page
    .locator('[data-testid^="scene-tree-row-"][data-depth="0"]')
    .first()
    .click({ button: 'right' });
  await page.getByTestId('outliner-ctx-new-collection').click();
  await expect.poll(async () => (await nodeIds(page)).length).toBe(before.size + 1);
  const col = (await nodeIds(page)).find((id) => !before.has(id))!;
  await page.getByTestId(`scene-tree-row-${col}`).click();
  await expect(page.getByTestId(`scene-tree-row-${col}`)).toHaveAttribute(
    'data-active-collection',
    'true',
  );
  return col;
}

test('#1453 — a light’s eye turns it off, and an added light joins the active collection and hides with it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_light_world_positions),
  );

  const [light] = await objectsOver(page, 'LightData');
  expect(light, 'the default scene has a light').toBeTruthy();
  const lit = await lightCount(page);
  expect(lit).toBeGreaterThan(0);

  // Its own eye: one light fewer in the scene; again, it is back.
  await page.getByTestId(`scene-tree-eye-${light}`).click();
  await expect
    .poll(() => lightCount(page), { message: 'the hidden light lights nothing' })
    .toBe(lit - 1);
  await page.getByTestId(`scene-tree-eye-${light}`).click();
  await expect.poll(() => lightCount(page)).toBe(lit);

  // Shift+A ▸ Light ▸ Point with a collection active: it joins, and the collection's eye hides it.
  const col = await newActiveCollection(page);
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-light').click();
  await page.getByTestId('add-menu-item-PointLight').click();
  await expect.poll(() => membersOf(page, col)).toHaveLength(1);
  const [added] = await membersOf(page, col);
  expect(await objectsOver(page, 'LightData')).toContain(added);
  await expect.poll(() => lightCount(page)).toBe(lit + 1);
  await page.getByTestId(`scene-tree-eye-${col}`).click();
  await expect.poll(() => lightCount(page), { message: 'the collection hidden' }).toBe(lit);
  expect(errors).toEqual([]);
});

test('#1453 — a camera’s eye hides its frustum, and M puts it into a collection that hides it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });

  const [cam] = await objectsOver(page, 'CameraData');
  expect(cam, 'the default scene has a camera').toBeTruthy();
  await expect.poll(() => hasFrustum(page, cam)).toBe(true);

  await page.getByTestId(`scene-tree-eye-${cam}`).click();
  await expect.poll(() => hasFrustum(page, cam), { message: 'the hidden camera' }).toBe(false);
  await page.getByTestId(`scene-tree-eye-${cam}`).click();
  await expect.poll(() => hasFrustum(page, cam)).toBe(true);

  // M ▸ New Collection on the camera, then the collection's eye.
  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection.getState().select(id),
    cam,
  );
  const before = new Set(await nodeIds(page));
  await page.locator('canvas').first().hover();
  await page.keyboard.press('m');
  await page.getByTestId('move-to-collection-new').click();
  await expect.poll(async () => (await nodeIds(page)).length).toBe(before.size + 1);
  const col = (await nodeIds(page)).find((id) => !before.has(id))!;
  expect(await membersOf(page, col)).toEqual([cam]);
  await page.getByTestId(`scene-tree-eye-${col}`).click();
  await expect.poll(() => hasFrustum(page, cam), { message: 'the collection hidden' }).toBe(false);
  expect(errors).toEqual([]);
});
