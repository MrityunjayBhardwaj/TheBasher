// #1516 / #1517 — a reparent and a delete leave what they move where it is drawn. What three draws
// is read off the live scene, before and after real gestures: an outliner drag, Ctrl+P, Alt+P, the
// Delete key.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { dragRowOnto } from './_treeDrag';

interface O3 {
  name?: string;
  isMesh?: boolean;
  userData?: Record<string, unknown>;
  matrixWorld: { elements: number[] };
  updateMatrixWorld: (force?: boolean) => void;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene: { node: string } };
        nodes: Record<
          string,
          {
            type: string;
            params: Record<string, unknown>;
            inputs: Record<string, { node: string }[] | undefined>;
          }
        >;
      };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
      undo: () => void;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string) => void; selectMany: (ids: string[]) => void };
  };
  __basher_three?: { getState: () => { scene?: O3 } };
}

test.setTimeout(120_000);

/** The drawn mesh of `id`: position and the matrix's first column, which a turn or a scale moves. */
const drawnAt = (page: Page, id: string) =>
  page.evaluate((target) => {
    const scene = (window as unknown as W).__basher_three!.getState().scene;
    if (!scene) return ['no three scene'];
    scene.updateMatrixWorld(true);
    let at: number[] | null = null;
    const walk = (o: O3, mine: boolean) => {
      if ((o as unknown as { visible: boolean }).visible === false) return;
      const stamp = o.userData?.basherNodeId;
      const owner =
        o.name === target || stamp === target ? true : typeof stamp === 'string' ? false : mine;
      if (owner && o.isMesh && !at) {
        const e = o.matrixWorld.elements;
        at = [e[12], e[13], e[14], e[0], e[1], e[2]].map((v) => +v.toFixed(3));
      }
      for (const c of (o as unknown as { children: O3[] }).children) walk(c, owner);
    };
    walk(scene, false);
    return at;
  }, id);

const childrenOf = (page: Page, id: string) =>
  page.evaluate((nodeId) => {
    const s = (window as unknown as W).__basher_dag.getState().state;
    const n = nodeId === '__scene__' ? s.nodes[s.outputs.scene.node] : s.nodes[nodeId];
    if (!n) return null;
    // The scene's list says who is a member; a group's children hang by their parent input.
    if (nodeId === '__scene__') return (n.inputs.children ?? []).map((c) => c.node);
    return Object.entries(s.nodes)
      .filter(
        ([, c]) => (c.inputs as unknown as { parent?: { node: string } }).parent?.node === nodeId,
      )
      .map(([cid]) => cid);
  }, id);

const hasNode = (page: Page, id: string) =>
  page.evaluate(
    (nodeId) => Boolean((window as unknown as W).__basher_dag.getState().state.nodes[nodeId]),
    id,
  );

const select = (page: Page, ids: string[]) =>
  page.evaluate((list) => {
    (window as unknown as W).__basher_selection.getState().selectMany(list);
  }, ids);

/** scene → OUTER → INNER, each offset and turned; the cube at the top, posed. */
async function setUp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
    timeout: 60_000,
  });
  await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const group = (id: string, parent: string, position: number[], rotation: number[]) => [
      {
        type: 'addNode',
        nodeId: id,
        nodeType: 'Group',
        params: { position, rotation, scale: [2, 2, 2], pivot: [0, 0, 0] },
      },
      {
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      ...(parent === 'n_scene'
        ? []
        : [
            {
              type: 'connect',
              from: { node: parent, socket: 'world' },
              to: { node: id, socket: 'parent' },
            },
          ]),
    ];
    dag.dispatchAtomic(
      [
        ...group('OUTER', 'n_scene', [5, 1, 0], [0, 30, 0]),
        ...group('INNER', 'OUTER', [0, 2, 1], [20, 0, 0]),
        { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [1, 2, 3] },
        { type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: [10, 20, 30] },
      ],
      'user',
      'set up',
    );
  });
  await expect(page.getByTestId('scene-tree-row-INNER')).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await drawnAt(page, 'n_box'))?.length, { timeout: 90_000 })
    .toBe(6);
}

test('a cube dragged into a turned group and back out does not move on screen', async ({
  page,
}) => {
  await setUp(page);
  const home = await drawnAt(page, 'n_box');

  await dragRowOnto(page, 'n_box', 'INNER');
  expect(await childrenOf(page, 'INNER')).toEqual(['n_box']);
  const inside = await drawnAt(page, 'n_box');
  expect(inside).toEqual(home);

  await dragRowOnto(page, 'n_box', 'n_scene');
  expect(await childrenOf(page, 'INNER')).toEqual([]);
  const out = await drawnAt(page, 'n_box');
  expect(out).toEqual(home);

  // Alt: the values stay, the object goes where they put it.
  await dragRowOnto(page, 'n_box', 'INNER', 'into', { altKey: true });
  const alt = await drawnAt(page, 'n_box');
  expect(alt).not.toEqual(home);
});

test('Ctrl+P and Alt+P keep the place, one undo each', async ({ page }) => {
  await setUp(page);
  const home = await drawnAt(page, 'n_box');
  await select(page, ['n_box', 'INNER']); // the last is the active one
  await page.keyboard.press('Control+p');
  await expect.poll(() => childrenOf(page, 'INNER')).toEqual(['n_box']);
  const parented = await drawnAt(page, 'n_box');
  expect(parented).toEqual(home);

  await select(page, ['n_box']);
  await page.keyboard.press('Alt+p');
  await expect.poll(() => childrenOf(page, 'INNER')).toEqual([]);
  expect(await childrenOf(page, '__scene__')).toContain('n_box');
  const cleared = await drawnAt(page, 'n_box');
  expect(cleared).toEqual(home);

  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect.poll(() => childrenOf(page, 'INNER')).toEqual(['n_box']);
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect.poll(() => childrenOf(page, 'INNER')).toEqual([]);
  expect(await drawnAt(page, 'n_box')).toEqual(home);
});

test('deleting a group hands its cube to the group’s parent, in place', async ({ page }) => {
  await setUp(page);
  await dragRowOnto(page, 'n_box', 'INNER');
  const home = await drawnAt(page, 'n_box');
  await select(page, ['INNER']);
  await page.keyboard.press('Delete');
  await expect.poll(() => hasNode(page, 'INNER')).toBe(false);
  expect(await childrenOf(page, 'OUTER')).toEqual(['n_box']);
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  const after = await drawnAt(page, 'n_box');
  expect(after).toEqual(home);

  // One undo puts the group and the cube's values back.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect.poll(() => childrenOf(page, 'INNER')).toEqual(['n_box']);
  expect(await drawnAt(page, 'n_box')).toEqual(home);
});

test('nested groups deleted together pass the cube up past both', async ({ page }) => {
  await setUp(page);
  await dragRowOnto(page, 'n_box', 'INNER');
  const home = await drawnAt(page, 'n_box');
  await select(page, ['OUTER', 'INNER']);
  await page.keyboard.press('Delete');
  await expect.poll(() => hasNode(page, 'OUTER')).toBe(false);
  expect(await hasNode(page, 'INNER')).toBe(false);
  expect(await childrenOf(page, '__scene__')).toContain('n_box');
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  const after = await drawnAt(page, 'n_box');
  expect(after).toEqual(home);
});

test('the group and the cube deleted together are both gone', async ({ page }) => {
  await setUp(page);
  await dragRowOnto(page, 'n_box', 'INNER');
  await select(page, ['INNER', 'n_box']);
  await page.keyboard.press('Delete');
  await expect.poll(() => hasNode(page, 'INNER')).toBe(false);
  expect(await hasNode(page, 'n_box')).toBe(false);
  expect(await hasNode(page, 'n_box_data')).toBe(false);
  expect(await drawnAt(page, 'n_box')).toBeNull();
  await expect(page.getByTestId('scene-tree-row-n_box')).toHaveCount(0);
});

test('a keyed cube is refused by name, and nothing moves', async ({ page }) => {
  await setUp(page);
  await page.evaluate(() => {
    (window as unknown as W).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'ch',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'n_box',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [1, 2, 3], easing: 'linear' },
              { time: 2, value: [1, 6, 3], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'key the cube',
    );
  });
  const home = await drawnAt(page, 'n_box');
  await dragRowOnto(page, 'n_box', 'INNER');
  expect(await childrenOf(page, 'INNER')).toEqual([]);
  await expect(page.getByText(/is animated/).first()).toBeVisible();
  expect(await drawnAt(page, 'n_box')).toEqual(home);

  await dragRowOnto(page, 'n_box', 'INNER', 'into', { altKey: true });
  expect(await childrenOf(page, 'INNER')).toEqual(['n_box']);
  const underInner = await drawnAt(page, 'n_box');
  await select(page, ['INNER']);
  await page.keyboard.press('Delete');
  // Delete has nothing to stay under, so the cube goes up with its keys and moves, and says so.
  await expect.poll(() => hasNode(page, 'INNER')).toBe(false);
  expect(await childrenOf(page, 'OUTER')).toEqual(['n_box']);
  await expect(page.getByText(/Delete moved/).first()).toBeVisible();
  await expect.poll(() => drawnAt(page, 'n_box')).not.toEqual(underInner);

  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect.poll(() => childrenOf(page, 'INNER')).toEqual(['n_box']);
  expect(await drawnAt(page, 'n_box')).toEqual(underInner);
});

test('Delete Hierarchy on a group takes what is below it, and one undo brings it back', async ({
  page,
}) => {
  await setUp(page);
  await dragRowOnto(page, 'n_box', 'INNER');
  const home = await drawnAt(page, 'n_box');
  await page.getByTestId('scene-tree-row-OUTER').click({ button: 'right' });
  await page.getByTestId('outliner-ctx-delete-hierarchy').click();
  await expect.poll(() => hasNode(page, 'OUTER')).toBe(false);
  expect(await hasNode(page, 'INNER')).toBe(false);
  expect(await hasNode(page, 'n_box')).toBe(false);
  await expect(page.getByTestId('scene-tree-row-n_box')).toHaveCount(0);

  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect.poll(() => hasNode(page, 'n_box')).toBe(true);
  expect(await drawnAt(page, 'n_box')).toEqual(home);
});

test('a row with nothing below it is not offered Delete Hierarchy', async ({ page }) => {
  await setUp(page);
  await page.getByTestId('scene-tree-row-n_box').click({ button: 'right' });
  await expect(page.getByTestId('outliner-ctx-delete')).toBeVisible();
  await expect(page.getByTestId('outliner-ctx-delete-hierarchy')).toHaveCount(0);
});

// #1861 — Alt+Delete (and Alt+Backspace, and the outliner's entry) deletes a parent and lets its
// children keep their own values: each hangs from the deleted node's parent at those values, so it
// lands somewhere else on screen. Plain Delete, above, keeps it where it was drawn.
const ownValues = (page: Page, id: string) =>
  page.evaluate((nodeId) => {
    const p = (window as unknown as W).__basher_dag.getState().state.nodes[nodeId].params;
    return JSON.stringify([p.position, p.rotation, p.scale]);
  }, id);

for (const key of ['Alt+Delete', 'Alt+Backspace']) {
  test(`${key} deletes a group and its child keeps its own values under the group's parent`, async ({
    page,
  }) => {
    await setUp(page);
    await dragRowOnto(page, 'n_box', 'INNER');
    const values = await ownValues(page, 'n_box');
    const drawn = await drawnAt(page, 'n_box');
    await select(page, ['INNER']);
    await page.keyboard.press(key);
    await expect.poll(() => hasNode(page, 'INNER')).toBe(false);
    expect(await childrenOf(page, 'OUTER')).toEqual(['n_box']);
    expect(await ownValues(page, 'n_box')).toEqual(values);
    await expect.poll(() => drawnAt(page, 'n_box')).not.toEqual(drawn);

    await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
    await expect.poll(() => childrenOf(page, 'INNER')).toEqual(['n_box']);
    expect(await drawnAt(page, 'n_box')).toEqual(drawn);
  });
}

test('the outliner offers the same delete on a row with children, and not on one without', async ({
  page,
}) => {
  await setUp(page);
  await dragRowOnto(page, 'n_box', 'INNER');
  const values = await ownValues(page, 'n_box');
  await page.getByTestId('scene-tree-row-n_box').click({ button: 'right' });
  await expect(page.getByTestId('outliner-ctx-delete')).toBeVisible();
  await expect(page.getByTestId('outliner-ctx-delete-keep-values')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('scene-tree-row-INNER').click({ button: 'right' });
  await page.getByTestId('outliner-ctx-delete-keep-values').click();
  await expect.poll(() => hasNode(page, 'INNER')).toBe(false);
  expect(await childrenOf(page, 'OUTER')).toEqual(['n_box']);
  expect(await ownValues(page, 'n_box')).toEqual(values);
});
