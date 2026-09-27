// #1065 — a strip's action and target, and a constraint's target, picked in the running app.
//
// Each picker is driven through the real <select>, and the effect is read off the drawn scene,
// not the DAG: a picker that writes a value nothing resolves would still pass a DAG read.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

interface W {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
  __basher_selection: { getState(): { select: (id: string) => void } };
  __basher_time: { getState(): { setTime: (t: number) => void } };
  __basher_dispatchMutator: (name: string, spec: unknown, intent: string) => { ok: boolean };
  __basher_mesh_world_quaternion: (id: string) => Quat | null;
  __basher_mesh_world_position: (id: string) => Vec3 | null;
}

async function boot(page: Page) {
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
      w.__basher_selection && w.__basher_dispatchMutator && w.__basher_mesh_world_position,
    );
  });
}

/** Two scene objects the viewport draws as meshes: the starter scene's, and a Sphere added
 *  through Add ▸ Mesh, the way a director would add one. Found, not assumed. */
async function twoDrawnObjects(page: Page): Promise<[string, string]> {
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-mesh').click();
  await page.getByTestId('add-menu-item-Sphere').click();
  await page.waitForTimeout(400);
  const ids = await page.evaluate(() => {
    const w = window as unknown as W;
    return Object.entries(w.__basher_dag.getState().state.nodes)
      .filter(([id, n]) => n.type === 'Object' && w.__basher_mesh_world_position(id) !== null)
      .map(([id]) => id);
  });
  expect(ids.length, 'the starter scene draws at least two objects').toBeGreaterThanOrEqual(2);
  return [ids[0], ids[1]];
}

function shown(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const s = el as HTMLSelectElement;
    return {
      value: s.value,
      selectedText: s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : null,
      stale: s.dataset.stale ?? null,
      options: [...s.options].map((o) => o.value),
    };
  });
}

function dispatch(page: Page, op: unknown) {
  return page.evaluate(
    (o) => (window as unknown as W).__basher_dag.getState().dispatch(o, 'user', 'e2e'),
    op,
  );
}

const quatOf = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as W).__basher_mesh_world_quaternion(i), id);
const posOf = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as W).__basher_mesh_world_position(i), id);
const differs = (a: number[] | null, b: number[] | null) =>
  !!a && !!b && a.some((v, i) => Math.abs(v - b[i]) > 1e-4);

test('a Track-To is moved to another object from its target picker, and a bad target says why', async ({
  page,
}) => {
  await boot(page);
  const [a, b] = await twoDrawnObjects(page);
  const restA = await quatOf(page, a);
  const restB = await quatOf(page, b);

  await dispatch(page, {
    type: 'addNode',
    nodeId: 'con_e2e',
    nodeType: 'TrackTo',
    params: { target: a, aimPoint: [37, 11, -23] },
  });
  await expect.poll(async () => differs(await quatOf(page, a), restA), 'A is aimed').toBe(true);

  await page.evaluate(() =>
    (window as unknown as W).__basher_selection.getState().select('con_e2e'),
  );
  const testid = 'inspector-options-con_e2e-target';
  const opened = await shown(page, testid);
  expect(opened.value).toBe(a);
  expect(opened.stale).toBeNull();
  expect(opened.options).toEqual(expect.arrayContaining(['', a, b]));

  // Choosing B in the real <select> moves the aim: B turns, and A returns to its own rotation.
  await page.getByTestId(testid).selectOption(b);
  await expect.poll(async () => differs(await quatOf(page, b), restB), 'B is aimed').toBe(true);
  await expect.poll(async () => differs(await quatOf(page, a), restA), 'A released').toBe(false);

  // A node that exists but cannot be placed is not "not found" — it is the wrong kind. B's own
  // data node is the likely mistake: it holds B's shape, but the resolver places the Object.
  const unplaced = await page.evaluate((obj) => {
    const n = (window as unknown as W).__basher_dag.getState().state.nodes[obj] as unknown as {
      inputs?: { data?: { node?: string } };
    };
    return n.inputs?.data?.node ?? null;
  }, b);
  expect(unplaced, 'B has a data node to point at').not.toBeNull();
  await dispatch(page, {
    type: 'setParam',
    nodeId: 'con_e2e',
    paramPath: 'target',
    value: unplaced,
  });
  await expect
    .poll(() => shown(page, testid))
    .toMatchObject({
      value: unplaced,
      stale: 'true',
      selectedText: expect.stringMatching(/— not a valid target$/),
    });

  // An id that names nothing says so, and keeps the id rather than showing "— none —".
  await dispatch(page, {
    type: 'setParam',
    nodeId: 'con_e2e',
    paramPath: 'target',
    value: 'ghost',
  });
  await expect
    .poll(() => shown(page, testid))
    .toMatchObject({ value: 'ghost', stale: 'true', selectedText: 'ghost — not found' });
});

test('a strip is moved to another object from its target picker, and its action is picked from the Actions', async ({
  page,
}) => {
  await boot(page);
  const [a, b] = await twoDrawnObjects(page);
  const [pa, pb] = [await posOf(page, a), await posOf(page, b)];

  const made = await page.evaluate(
    ([target]) => {
      const w = window as unknown as W;
      const action = w.__basher_dispatchMutator(
        'mutator.nla.createAction',
        {
          name: 'slide',
          actionId: 'act_e2e',
          channels: [
            {
              valueType: 'vec3',
              paramPath: 'position',
              keyframes: [
                { time: 0, value: [0, 3, 0], easing: 'linear' },
                { time: 2, value: [4, 3, 0], easing: 'linear' },
              ],
            },
          ],
        },
        'e2e',
      );
      const strip = w.__basher_dispatchMutator(
        'mutator.nla.addStrip',
        { action: 'act_e2e', target, stripId: 'strip_e2e', start: 0 },
        'e2e',
      );
      return [action.ok, strip.ok];
    },
    [a],
  );
  expect(made).toEqual([true, true]);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
  await expect.poll(async () => differs(await posOf(page, a), pa), 'the strip moves A').toBe(true);

  await page.evaluate(() =>
    (window as unknown as W).__basher_selection.getState().select('strip_e2e'),
  );
  const action = await shown(page, 'inspector-options-strip_e2e-action');
  expect(action).toMatchObject({ value: 'act_e2e', stale: null, selectedText: 'slide' });

  const target = 'inspector-options-strip_e2e-target';
  expect((await shown(page, target)).options).toEqual(expect.arrayContaining(['', a, b]));
  await page.getByTestId(target).selectOption(b);
  await expect.poll(async () => differs(await posOf(page, b), pb), 'the strip moves B').toBe(true);
  await expect.poll(async () => differs(await posOf(page, a), pa), 'A is left alone').toBe(false);

  // Clearing the action through its picker stops the strip: B returns to where it stood.
  await page.getByTestId('inspector-options-strip_e2e-action').selectOption('');
  await expect
    .poll(async () => differs(await posOf(page, b), pb), 'no action, no motion')
    .toBe(false);
});
