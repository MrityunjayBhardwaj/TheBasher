// #1842 — a light a band draws stays on its band and stands at its world, parent included. Each row
// moves the parent and counts the real lights, with a cube under the same parent as the control.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitLightOps } from './_splitLight';

type V3 = [number, number, number];
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { inputs: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
      dispatchAtomic: (ops: unknown[], source: string, description: string) => void;
    };
  };
  __basher_selection: { getState: () => { selectMany: (ids: string[]) => void } };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_mesh_world_position: (id: string) => number[] | null;
  __basher_light_world_positions: () => V3[];
  __basher_light_world_aims: () => { position: V3; direction: V3 }[];
  __basher_render_png?: () => Promise<{ dataUrl: string } | null>;
}

async function boot(page: Page): Promise<string> {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(
      w.__basher_dag?.getState().state.outputs.scene && w.__basher_light_world_positions,
    );
  });
  return page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_time.getState().pause();
    w.__basher_time.getState().setTime(0);
    return w.__basher_dag.getState().state.outputs.scene!.node;
  });
}

const dispatch = (page: Page, ops: unknown[]) =>
  page.evaluate(
    (list) => (window as unknown as W).__basher_dag.getState().dispatchAtomic(list, 'user', 'e2e'),
    ops,
  );
const conn = (node: string, socket: string, toNode: string, toSocket: string) => ({
  type: 'connect',
  from: { node, socket },
  to: { node: toNode, socket: toSocket },
});
const setP = (nodeId: string, paramPath: string, value: unknown) => ({
  type: 'setParam',
  nodeId,
  paramPath,
  value,
});
const lights = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_light_world_positions());
const count = (page: Page) => lights(page).then((l) => l.length);
/** How many real lights stand at `at`: a count, because a list search cannot see a doubled light. */
const lightsAt = (page: Page, at: V3) =>
  lights(page).then(
    (l) => l.filter((p) => Math.max(...p.map((v, i) => Math.abs(v - at[i]))) < 0.01).length,
  );
const meshAt = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as W).__basher_mesh_world_position(i), id);
const listed = (page: Page, node: string, socket: string) =>
  page.evaluate(
    ([n, s]) => {
      const v = (window as unknown as W).__basher_dag.getState().state.nodes[n]?.inputs[s];
      return ((Array.isArray(v) ? v : v ? [v] : []) as { node: string }[]).map((r) => r.node);
    },
    [node, socket] as const,
  );

async function withGroup(page: Page, sceneId: string) {
  await dispatch(page, [
    { type: 'addNode', nodeId: 'G', nodeType: 'Object', params: { position: [5, 1, 0] } },
    conn('G', 'out', sceneId, 'children'),
    conn('G', 'world', 'n_box', 'parent'),
  ]);
  await expect.poll(() => meshAt(page, 'n_box')).toEqual([5, 1, 0]);
}

/** A light far from the starter scene's own, so a count at its spot is about it alone. */
const HOME: V3 = [7, 7, 7];

async function withRigLight(page: Page, sceneId: string) {
  await dispatch(page, [
    ...splitLightOps({
      objectId: 'rig_l',
      lightKind: 'Point',
      position: HOME,
      shading: { intensity: 5, color: '#ffffff' },
    }),
    { type: 'addNode', nodeId: 'rig_node', nodeType: 'LightRig', params: { name: 'Key' } },
    conn('rig_l', 'out', 'rig_node', 'lights'),
    conn('rig_node', 'out', sceneId, 'lightRig'),
  ]);
  await expect.poll(() => lightsAt(page, HOME)).toBe(1);
}

const select = (page: Page, ids: string[]) =>
  page.evaluate((l) => (window as unknown as W).__basher_selection.getState().selectMany(l), ids);

test('on the scene list, by a raw parent wire: the light moves with its parent', async ({
  page,
}) => {
  const sceneId = await boot(page);
  await withGroup(page, sceneId);
  await dispatch(page, [
    ...splitLightOps({ objectId: 'l', lightKind: 'Point', position: HOME }),
    conn('l', 'out', sceneId, 'lights'),
  ]);
  const total = await expect
    .poll(() => lightsAt(page, HOME))
    .toBe(1)
    .then(() => count(page));

  await dispatch(page, [conn('G', 'world', 'l', 'parent')]);
  await expect.poll(() => lightsAt(page, [12, 8, 7])).toBe(1);
  expect(await lightsAt(page, HOME)).toBe(0);

  await dispatch(page, [setP('G', 'position', [8, 1, 0])]);
  await expect.poll(() => meshAt(page, 'n_box')).toEqual([8, 1, 0]);
  await expect.poll(() => lightsAt(page, [15, 8, 7])).toBe(1);
  expect(await count(page)).toBe(total);
  expect(await listed(page, sceneId, 'lights')).toContain('l');
});

test('a rig light, Ctrl+P: it stays where it stands and on its rig, and the parent carries it', async ({
  page,
}) => {
  const sceneId = await boot(page);
  await withGroup(page, sceneId);
  await withRigLight(page, sceneId);
  const total = await count(page);

  await select(page, ['rig_l', 'G']);
  await page.keyboard.press('Control+p');
  await expect.poll(() => listed(page, 'rig_l', 'parent')).toEqual(['G']);
  await expect.poll(() => lightsAt(page, HOME)).toBe(1);
  expect(await listed(page, 'rig_node', 'lights')).toContain('rig_l');

  await dispatch(page, [setP('G', 'position', [8, 1, 0])]);
  await expect.poll(() => lightsAt(page, [10, 7, 7])).toBe(1);
  expect(await lightsAt(page, HOME)).toBe(0);
  expect(await count(page)).toBe(total);
});

test('a rig light, Alt+P: it stays where it stands, on its rig, drawn once', async ({ page }) => {
  const sceneId = await boot(page);
  await withGroup(page, sceneId);
  await withRigLight(page, sceneId);
  const total = await count(page);
  await select(page, ['rig_l', 'G']);
  await page.keyboard.press('Control+p');
  await expect.poll(() => listed(page, 'rig_l', 'parent')).toEqual(['G']);

  await select(page, ['rig_l']);
  await page.keyboard.press('Alt+p');
  await expect.poll(() => listed(page, 'rig_l', 'parent')).toEqual([]);
  await expect.poll(() => lightsAt(page, HOME)).toBe(1);
  expect(await count(page)).toBe(total);
  expect(await listed(page, sceneId, 'lights')).not.toContain('rig_l');
});

test('a hung rig light still goes with its profile', async ({ page }) => {
  const sceneId = await boot(page);
  await withGroup(page, sceneId);
  await withRigLight(page, sceneId);
  const total = await count(page);
  await dispatch(page, [conn('G', 'world', 'rig_l', 'parent')]);
  await expect.poll(() => lightsAt(page, [12, 8, 7])).toBe(1);

  await dispatch(page, [
    {
      type: 'disconnect',
      from: { node: 'rig_node', socket: 'out' },
      to: { node: sceneId, socket: 'lightRig' },
    },
  ]);
  await expect.poll(() => count(page)).toBe(total - 1);
  expect(await lightsAt(page, [12, 8, 7])).toBe(0);
  expect(await listed(page, 'rig_l', 'parent')).toEqual(['G']);
});

test('the render lights from where the viewport says: moving the parent changes the picture', async ({
  page,
}) => {
  const sceneId = await boot(page);
  await dispatch(page, [
    { type: 'addNode', nodeId: 'G', nodeType: 'Object', params: { position: [0, 0, 0] } },
    conn('G', 'out', sceneId, 'children'),
    ...splitLightOps({
      objectId: 'rig_l',
      lightKind: 'Point',
      position: [0, 3, 3],
      shading: { intensity: 60, color: '#ff0000' },
    }),
    { type: 'addNode', nodeId: 'rig_node', nodeType: 'LightRig', params: { name: 'Key' } },
    conn('rig_l', 'out', 'rig_node', 'lights'),
    conn('rig_node', 'out', sceneId, 'lightRig'),
    conn('G', 'world', 'rig_l', 'parent'),
  ]);
  const shot = () =>
    page.evaluate(
      async () => (await (window as unknown as W).__basher_render_png!())?.dataUrl ?? null,
    );
  await expect.poll(() => lightsAt(page, [0, 3, 3])).toBe(1);
  const before = await shot();
  expect(before).toBeTruthy();
  // Control: with nothing changed the picture is the same, so a difference below is the light.
  expect(await shot()).toBe(before);
  await dispatch(page, [setP('G', 'position', [0, 0, -30])]);
  await expect.poll(() => lightsAt(page, [0, 3, -27])).toBe(1);
  const after = await shot();
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);
});

test('a hung sun on a rig, aimed, under a turned parent: it stands at its world and faces the aim', async ({
  page,
}) => {
  const sceneId = await boot(page);
  const AIM: V3 = [5, 0, -5];
  await dispatch(page, [
    {
      type: 'addNode',
      nodeId: 'G',
      nodeType: 'Object',
      params: { position: [5, 1, 0], rotation: [0, 0, 90] },
    },
    conn('G', 'out', sceneId, 'children'),
    ...splitLightOps({ objectId: 'rig_l', lightKind: 'Directional', position: [3, 0, 2] }),
    { type: 'addNode', nodeId: 'rig_node', nodeType: 'LightRig', params: { name: 'Key' } },
    conn('rig_l', 'out', 'rig_node', 'lights'),
    conn('rig_node', 'out', sceneId, 'lightRig'),
    conn('G', 'world', 'rig_l', 'parent'),
    {
      type: 'addNode',
      nodeId: 'rig_tt',
      nodeType: 'TrackTo',
      params: { target: 'rig_l', aimNode: '', aimPoint: AIM, up: [0, 0, 1] },
    },
  ]);
  // (3, 0, 2) under a parent at (5, 1, 0) turned 90 degrees about Z.
  const WORLD: V3 = [5, 4, 2];
  await expect.poll(() => lightsAt(page, WORLD)).toBe(1);
  const want = [AIM[0] - WORLD[0], AIM[1] - WORLD[1], AIM[2] - WORLD[2]];
  const len = Math.hypot(...want);
  const off = () =>
    page.evaluate(
      ([at, dir]) => {
        const aims = (window as unknown as W).__basher_light_world_aims();
        const near = aims.filter(
          (a) => Math.max(...a.position.map((v, i) => Math.abs(v - at[i]))) < 0.01,
        );
        if (near.length !== 1) return Infinity;
        return Math.max(...near[0].direction.map((v, i) => Math.abs(v - dir[i])));
      },
      [WORLD, want.map((v) => v / len)] as const,
    );
  await expect.poll(off).toBeLessThan(0.001);
});

test('a parent with keys carries a hung rig light through time', async ({ page }) => {
  const sceneId = await boot(page);
  await withGroup(page, sceneId);
  await withRigLight(page, sceneId);
  await dispatch(page, [conn('G', 'world', 'rig_l', 'parent')]);
  await expect.poll(() => lightsAt(page, [12, 8, 7])).toBe(1);

  const setTime = (s: number) =>
    page.evaluate((t) => (window as unknown as W).__basher_time.getState().setTime(t), s);
  await select(page, ['G']);
  const diamond = page.getByTestId('inspector-diamond-G-position');
  await diamond.click();
  await setTime(1);
  await dispatch(page, [setP('G', 'position', [8, 1, 0])]);
  await diamond.click();

  await expect.poll(() => lightsAt(page, [15, 8, 7])).toBe(1);
  await setTime(0);
  await expect.poll(() => lightsAt(page, [12, 8, 7])).toBe(1);
  await setTime(0.5);
  await expect.poll(() => lightsAt(page, [13.5, 8, 7])).toBe(1);
});

test('under an aimed parent, a hung light lands where a cube hung the same way lands', async ({
  page,
}) => {
  const sceneId = await boot(page);
  await dispatch(page, [
    { type: 'addNode', nodeId: 'G', nodeType: 'Object', params: { position: [5, 1, 0] } },
    conn('G', 'out', sceneId, 'children'),
    {
      type: 'addNode',
      nodeId: 'g_tt',
      nodeType: 'TrackTo',
      params: { target: 'G', aimNode: '', aimPoint: [5, 9, 0], up: [0, 0, 1] },
    },
    setP('n_box', 'position', [2, 3, 1]),
    conn('G', 'world', 'n_box', 'parent'),
    ...splitLightOps({ objectId: 'rig_l', lightKind: 'Point', position: [2, 3, 1] }),
    { type: 'addNode', nodeId: 'rig_node', nodeType: 'LightRig', params: { name: 'Key' } },
    conn('rig_l', 'out', 'rig_node', 'lights'),
    conn('rig_node', 'out', sceneId, 'lightRig'),
    conn('G', 'world', 'rig_l', 'parent'),
  ]);
  // Unturned, the two would stand at (7, 4, 1), so landing there means the aim was left out.
  const cube = async () => {
    const at = (await meshAt(page, 'n_box')) as V3 | null;
    return at && Math.max(...at.map((v, i) => Math.abs(v - [7, 4, 1][i]))) > 0.5 ? at : null;
  };
  await expect.poll(cube).not.toBeNull();
  const at = (await cube())!;
  await expect.poll(() => lightsAt(page, at)).toBe(1);
});
