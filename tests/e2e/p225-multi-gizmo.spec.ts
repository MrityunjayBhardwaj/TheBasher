// #225 — the selected SET acts as a unit. Part 2: the multi-object gizmo.
// When >1 manipulable node is selected, ONE proxy sits at the MEDIAN of their
// world positions and a drag applies the proxy's incremental world transform
// to EVERY node about that shared pivot (Blender "median point").
//
// Boundary-pair: side A = the REAL committed proxy grab (__basher_gizmo_grab
// drives the actual onObjectChange), side B = each node's LOCAL params after.
// Math gate: translate = same world delta on all; rotate = orbit about median.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: Record<string, { node: string }>;
        nodes: Record<string, { params?: { position?: number[]; rotation?: number[] } }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_selection: { getState: () => { selectMany: (ids: string[]) => void } };
  __basher_gizmo_multi?: () => { count: number; pivot: number[] };
  __basher_gizmo_grab?: (mode: string, target: [number, number, number]) => void;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as BasherWindow).__basher_dag &&
          (window as unknown as BasherWindow).__basher_selection,
      ),
    { timeout: 15000 },
  );
  // Second box at [4,0,0]; n_box is at [0,0,0] → median [2,0,0].
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_box_b',
          nodeType: 'BoxMesh',
          params: { size: [1, 1, 1], position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        { type: 'connect', from: { node: 'n_box_b', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
      ],
      'user',
      'add box b',
    );
  });
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_selection.getState().selectMany(['n_box', 'n_box_b']),
  );
  await page.waitForTimeout(400);
});

test('multi gizmo seeds at the median and translates every node by the same delta', async ({
  page,
}) => {
  const multi = await page.evaluate(() => (window as unknown as BasherWindow).__basher_gizmo_multi?.());
  expect(multi?.count).toBe(2);
  expect(multi?.pivot).toEqual([2, 0, 0]);

  // proxy [2,0,0] → [5,0,0] = delta [3,0,0]; both nodes shift by it.
  await page.evaluate(() => (window as unknown as BasherWindow).__basher_gizmo_grab?.('translate', [5, 0, 0]));
  await page.waitForTimeout(150);
  const ps = await page.evaluate(() => {
    const n = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    return [n['n_box'].params!.position, n['n_box_b'].params!.position];
  });
  expect(ps[0]).toEqual([3, 0, 0]);
  expect(ps[1]).toEqual([7, 0, 0]);
});

test('multi gizmo rotates every node about the median pivot', async ({ page }) => {
  // 90° about Y about pivot [2,0,0]: n_box [0,0,0]→[2,0,2], n_box_b [4,0,0]→[2,0,-2].
  await page.evaluate(() => (window as unknown as BasherWindow).__basher_gizmo_grab?.('rotate', [0, 90, 0]));
  await page.waitForTimeout(150);
  const res = await page.evaluate(() => {
    const n = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    return {
      boxP: n['n_box'].params!.position,
      boxR: n['n_box'].params!.rotation,
      bP: n['n_box_b'].params!.position,
    };
  });
  expect(res.boxP![0]).toBeCloseTo(2, 3);
  expect(res.boxP![1]).toBeCloseTo(0, 3);
  expect(res.boxP![2]).toBeCloseTo(2, 3);
  expect(res.bP![0]).toBeCloseTo(2, 3);
  expect(res.bP![2]).toBeCloseTo(-2, 3);
  expect(res.boxR![1]).toBeCloseTo(90, 2);
});
