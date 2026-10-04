// #1462 — hiding an object hides that object alone. Blender 5.1.1 (observed headless): with parent P
// hidden, by its own eye or by a hidden collection holding it, `P.visible_get()` is False and its
// child C's is True; C still draws where P's transform puts it. Here: a cube P with a cube C
// parented under it at an offset, hidden through the outliner eye and then through M ▸ New
// Collection and that collection's eye. What three draws is read off the live scene, which is also
// what a render captures.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface O3 {
  name?: string;
  isMesh?: boolean;
  userData?: Record<string, unknown>;
  matrixWorld: { elements: number[] };
  traverse: (f: (o: O3) => void) => void;
  updateMatrixWorld: (force?: boolean) => void;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string) => void; primaryNodeId: string | null };
  };
  __basher_three?: { getState: () => { scene: O3 | null } };
}

const nodeIds = (page: Page) =>
  page.evaluate(() => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes));

/**
 * The world position of the mesh three draws for `id`: under the top-level wrapper named `id`, or
 * under the nested identity group stamped with it — and not inside another node's stamp, so a
 * parent's lookup never finds its child's mesh. Null when nothing of `id`'s own is drawn.
 */
const drawnAt = (page: Page, id: string) =>
  page.evaluate((target) => {
    const scene = (window as unknown as W).__basher_three!.getState().scene!;
    scene.updateMatrixWorld(true);
    let at: number[] | null = null;
    const walk = (o: O3, mine: boolean) => {
      const stamp = o.userData?.basherNodeId;
      const owner =
        o.name === target || stamp === target ? true : typeof stamp === 'string' ? false : mine;
      if (owner && o.isMesh && !at) {
        const e = o.matrixWorld.elements;
        at = [e[12], e[13], e[14]].map((v) => +v.toFixed(3));
      }
      for (const c of (o as unknown as { children: O3[] }).children) walk(c, owner);
    };
    walk(scene, false);
    return at;
  }, id);

async function addCube(page: Page): Promise<string> {
  const before = new Set(await nodeIds(page));
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-mesh').click();
  await page.getByTestId('add-menu-item-Cube').click();
  await expect.poll(async () => (await nodeIds(page)).length).toBeGreaterThan(before.size);
  return page.evaluate(
    (prior) =>
      Object.values((window as unknown as W).__basher_dag.getState().state.nodes).find(
        (n) => !prior.includes(n.id) && n.type === 'Object',
      )!.id,
    [...before],
  );
}

test('#1462 — a hidden parent draws nothing of its own, and its child still draws under it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });

  // P at (0, 2, 0); C under it at a local (3, 0, 0), so C draws at (3, 2, 0).
  const P = await addCube(page);
  const C = await addCube(page);
  await page.evaluate(
    ({ P, C }) => {
      const dag = (window as unknown as W).__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          { type: 'setParam', nodeId: P, paramPath: 'position', value: [0, 2, 0] },
          { type: 'setParam', nodeId: C, paramPath: 'position', value: [3, 0, 0] },
          {
            type: 'disconnect',
            from: { node: C, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
          {
            type: 'connect',
            from: { node: C, socket: 'out' },
            to: { node: P, socket: 'children' },
          },
        ],
        'user',
        'parent C under P',
      );
    },
    { P, C },
  );
  await expect.poll(() => drawnAt(page, P)).toEqual([0, 2, 0]);
  await expect.poll(() => drawnAt(page, C)).toEqual([3, 2, 0]);

  // P's own eye: P goes, C stays where P puts it.
  await page.getByTestId(`scene-tree-eye-${P}`).click();
  await expect.poll(() => drawnAt(page, P), { message: 'P hidden' }).toBeNull();
  await expect.poll(() => drawnAt(page, C), { message: 'C still drawn' }).toEqual([3, 2, 0]);

  // Its eye again brings it back.
  await page.getByTestId(`scene-tree-eye-${P}`).click();
  await expect.poll(() => drawnAt(page, P)).toEqual([0, 2, 0]);

  // M ▸ New Collection on P, then the collection's eye: the same, through membership.
  await page.evaluate((id) => (window as unknown as W).__basher_selection.getState().select(id), P);
  const before = new Set(await nodeIds(page));
  await page.locator('canvas').first().hover();
  await page.keyboard.press('m');
  await page.getByTestId('move-to-collection-new').click();
  await expect.poll(async () => (await nodeIds(page)).length).toBe(before.size + 1);
  const col = (await nodeIds(page)).find((id) => !before.has(id))!;
  await page.getByTestId(`scene-tree-eye-${col}`).click();
  await expect.poll(() => drawnAt(page, P), { message: 'P hidden by its collection' }).toBeNull();
  await expect
    .poll(() => drawnAt(page, C), { message: 'C not in it, still drawn' })
    .toEqual([3, 2, 0]);
  expect(errors).toEqual([]);
});
