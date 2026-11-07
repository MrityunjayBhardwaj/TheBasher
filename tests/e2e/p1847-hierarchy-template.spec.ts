// #1847 — a parent and its hung child collapse into a template and stand where they stood, in the
// viewport as well as in the graph, and a second instance draws its own pair.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCubeOps } from './_splitCube';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, unknown>; outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], source: string, description: string) => void;
    };
  };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_three: { getState: () => { scene: ThreeScene | null } };
  __basher_mesh_world_position: (id: string) => number[] | null;
}
interface ThreeObject {
  type: string;
  isMesh?: boolean;
  visible: boolean;
  parent: ThreeObject | null;
  updateWorldMatrix: (parents: boolean, children: boolean) => void;
  matrixWorld: { elements: number[] };
}
interface ThreeScene {
  traverse: (cb: (o: ThreeObject) => void) => void;
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
    return Boolean(w.__basher_dag?.getState().state.outputs.scene && w.__basher_three);
  });
}

/** Where every visible mesh really stands, read off the three.js scene: an object inside an
 *  instance has no id for the viewport's by-id read to find. Rounded and sorted. */
const meshes = (page: Page) =>
  page.evaluate(() => {
    const out: number[][] = [];
    (window as unknown as W).__basher_three.getState().scene?.traverse((o) => {
      if (!o.isMesh) return;
      for (let up: ThreeObject | null = o; up; up = up.parent) if (!up.visible) return;
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements;
      out.push([e[12], e[13], e[14]].map((v) => Math.round(v * 1000) / 1000));
    });
    return out.map((p) => p.join(',')).sort();
  });

test('the hierarchy collapses and both cubes stay drawn', async ({ page }) => {
  await boot(page);
  await page.evaluate(
    (ops) => {
      const dag = (window as unknown as W).__basher_dag.getState();
      dag.dispatchAtomic(ops, 'user', 'e2e');
    },
    [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [3, 0, 0] },
      ...splitCubeOps({ objectId: 'kid', position: [0, 2, 0] }),
      {
        type: 'connect',
        from: { node: 'n_box', socket: 'world' },
        to: { node: 'kid', socket: 'parent' },
      },
      {
        type: 'connect',
        from: { node: 'kid', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ],
  );
  const has = (want: string) => async () => (await meshes(page)).filter((p) => p === want).length;
  await expect.poll(has('3,2,0')).toBe(1);
  await expect.poll(has('3,0,0')).toBe(1);
  const before = await meshes(page);

  const collapse = async (id: string) =>
    page.evaluate(async (instance) => {
      const mod = await import('/src/app/templates.ts');
      const dag = (window as unknown as W).__basher_dag.getState();
      const plan = mod.planCollapseToTemplate(
        dag.state,
        ['n_box', 'n_box_data', 'kid', 'kid_data'],
        'Pair',
        instance,
      );
      if (!plan.ok) return plan.reason;
      dag.dispatchAtomic(plan.ops, 'user', 'collapse');
      return null;
    }, id);
  expect(await collapse('inst')).toBeNull();

  // The same meshes at the same places, nothing lost and nothing doubled.
  await expect.poll(() => meshes(page)).toEqual(before);
});
