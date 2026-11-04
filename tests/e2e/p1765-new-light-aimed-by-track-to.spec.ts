// #1765 — a new sun, spot or area light comes aimed at the world origin by a Track-To at an
// empty there ("Spot.aim"); moving the empty re-aims the light, and the object it aims at can be
// re-picked in its constraint stack. A point light shines every way, so it
// comes with none.
//
// Driven through the real surfaces: Shift+A ▸ Light ▸ Spot, the inspector's constraint stack, and
// the node-ref picker's <select>. Side A is the drawn SpotLight (its world −Z, the way it shines);
// side B is where it should face, normalize(aim − position), from the aim the DAG names.
// Falsified by adding the light without its Track-To, or with a Track-To but no empty
// (`lightAimOps`): the stack has no row, or the aim object is not an empty, and it goes red.

import { expect, test } from './_fixtures';

type V3 = [number, number, number];
interface W {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_selection: {
    getState(): { selectedNodeId: string | null; select: (id: string) => void };
  };
  __basher_three?: { getState: () => { scene: unknown } };
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForSelector('canvas');
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_three);
  });
}

const nodeIds = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    Object.keys((window as unknown as W).__basher_dag.getState().state.nodes).sort(),
  );

/** Shift+A ▸ Light ▸ `kind`; returns the ids the add minted. */
async function addLight(page: import('@playwright/test').Page, kind: string): Promise<string[]> {
  const before = new Set(await nodeIds(page));
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-light').click();
  await page.getByTestId(`add-menu-item-${kind}`).click();
  await expect.poll(async () => (await nodeIds(page)).length).toBeGreaterThan(before.size);
  return (await nodeIds(page)).filter((id) => !before.has(id));
}

/** The Track-To nodes aiming `objId`. */
const aimsOf = (page: import('@playwright/test').Page, objId: string) =>
  page.evaluate((id) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return Object.entries(nodes)
      .filter(([, n]) => n.type === 'TrackTo' && n.params.target === id)
      .map(([nid, n]) => ({ ...n.params, id: nid }) as { id: string; [k: string]: unknown });
  }, objId);

/** The one drawn SpotLight's world position and the way it shines (its world −Z). */
const drawnSpot = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const out: { p: number[]; d: number[] }[] = [];
    const scene = (window as unknown as W).__basher_three?.getState().scene as
      | { traverse: (f: (o: unknown) => void) => void }
      | undefined;
    scene?.traverse((o) => {
      const l = o as {
        isSpotLight?: boolean;
        updateWorldMatrix: (a: boolean, b: boolean) => void;
        matrixWorld: { elements: number[] };
      };
      if (!l.isSpotLight) return;
      l.updateWorldMatrix(true, false);
      const e = l.matrixWorld.elements;
      const z = Math.hypot(e[8], e[9], e[10]);
      out.push({ p: [e[12], e[13], e[14]], d: [-e[8] / z, -e[9] / z, -e[10] / z] });
    });
    return out;
  });

/** How far the drawn spot's direction is from facing `aim` from where it is drawn. */
async function missFrom(page: import('@playwright/test').Page, aim: V3): Promise<number | string> {
  const spots = await drawnSpot(page);
  if (spots.length !== 1) return `${spots.length} spot lights drawn`;
  const { p, d } = spots[0];
  const want = norm([aim[0] - p[0], aim[1] - p[1], aim[2] - p[2]]);
  return Math.max(...d.map((v, i) => Math.abs(v - want[i])));
}

/** A node's type, name and position, or null. */
const nodeOf = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((nid) => {
    const n = (window as unknown as W).__basher_dag.getState().state.nodes[nid] as
      | { type: string; params: Record<string, unknown>; meta?: { name?: string } }
      | undefined;
    return n ? { type: n.type, name: n.meta?.name ?? null, position: n.params.position } : null;
  }, id);

test('a new spot comes aimed at an empty at the origin, and its aim object can be re-picked in the inspector', async ({
  page,
}) => {
  await boot(page);
  const minted = await addLight(page, 'SpotLight');
  const objId = await page.evaluate(
    () => (window as unknown as W).__basher_selection.getState().selectedNodeId,
  );
  expect(objId, 'the add selects the new light').toBeTruthy();
  expect(minted).toContain(objId);

  // DAG side: one Track-To on it, aimed at an empty named after it, at the world origin.
  const aims = await aimsOf(page, objId!);
  expect(aims).toHaveLength(1);
  expect(aims[0]).toMatchObject({ aimPoint: [0, 0, 0], mute: false });
  const ttId = aims[0].id;
  const empty = await nodeOf(page, aims[0].aimNode as string);
  expect(empty).toMatchObject({ type: 'Null', name: 'Spot.aim', position: [0, 0, 0] });

  // Move it off the origin (the Add menu drops it at the orbit target), then it faces the origin.
  const FROM: V3 = [4, 5, -2];
  await page.evaluate(
    ([id, at]) =>
      (window as unknown as W).__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId: id, paramPath: 'position', value: at }),
    [objId!, FROM] as [string, V3],
  );
  await expect.poll(() => missFrom(page, [0, 0, 0])).toBeLessThan(1e-4);

  // The light's constraint stack shows the Track-To; a click on its row opens it.
  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection.getState().select(id),
    objId!,
  );
  await page.getByTestId('inspector-section-toggle-constraint').click();
  const row = page.getByTestId(`constraint-row-${ttId}`);
  await expect(row).toBeVisible();
  await row.locator('button').first().click();

  // Pick the camera as the aim object with the real <select>: the drawn light turns to it.
  const picker = page.getByTestId(`inspector-noderef-${ttId}-aimNode`);
  await expect(picker).toBeVisible();
  await picker.selectOption('n_camera');
  await expect.poll(async () => (await aimsOf(page, objId!))[0]?.aimNode).toBe('n_camera');
  const camera = (await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.nodes.n_camera.params.position,
  )) as V3;
  await expect.poll(() => missFrom(page, camera)).toBeLessThan(1e-4);
  // It genuinely turned: the origin is no longer where it faces.
  expect(await missFrom(page, [0, 0, 0])).toBeGreaterThan(0.1);
});

test('a new point light comes with no Track-To', async ({ page }) => {
  await boot(page);
  await addLight(page, 'PointLight');
  const objId = await page.evaluate(
    () => (window as unknown as W).__basher_selection.getState().selectedNodeId,
  );
  expect(objId).toBeTruthy();
  expect(await aimsOf(page, objId!)).toEqual([]);
});

// The user's handle: the light aims at an object, and moving that object re-aims the light.
test('moving a new spot’s "Spot.aim" empty in the viewport re-aims the light', async ({ page }) => {
  await boot(page);
  await addLight(page, 'SpotLight');
  const objId = (await page.evaluate(
    () => (window as unknown as W).__basher_selection.getState().selectedNodeId,
  ))!;
  const FROM: V3 = [4, 5, -2];
  await page.evaluate(
    ([id, at]) =>
      (window as unknown as W).__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId: id, paramPath: 'position', value: at }),
    [objId, FROM] as [string, V3],
  );
  const emptyId = (await aimsOf(page, objId))[0]?.aimNode as string;
  expect((await nodeOf(page, emptyId))?.type, 'the light aims at an empty').toBe('Null');
  await expect.poll(() => missFrom(page, [0, 0, 0])).toBeLessThan(1e-4);

  // Select the empty by its outliner row, then move it with the viewport's gizmo.
  await page.getByTestId(`scene-tree-row-${emptyId}`).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__basher_selection.getState().selectedNodeId),
    )
    .toBe(emptyId);
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_gizmo_grab?: unknown }).__basher_gizmo_grab),
  );
  const TO: V3 = [-3, 1, 2];
  await page.evaluate((to) => {
    (
      window as unknown as {
        __basher_gizmo_grab: (m: string, t: [number, number, number]) => void;
      }
    ).__basher_gizmo_grab('translate', to);
  }, TO);
  await expect.poll(async () => (await nodeOf(page, emptyId))?.position).toEqual(TO);
  // The drawn light now faces where the empty went, not the origin.
  await expect.poll(() => missFrom(page, TO)).toBeLessThan(1e-4);
  expect(await missFrom(page, [0, 0, 0])).toBeGreaterThan(0.1);
});
