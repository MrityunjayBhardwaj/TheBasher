// #228 Slice C — transform pivot point for the multi-object gizmo (Blender
// pivot_point/index.rst). Drives the REAL toolbar pivot <select> + the multi
// gizmo: median = average of origins, active = the primary node's origin,
// individual = each object rotates about its OWN origin (no orbit). Boundary:
// __basher_gizmo_multi() reports the seeded pivot; a rotate grab proves the
// individual application. pivotPoint math is unit-tested in gizmoPivot.test.ts.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params?: Record<string, unknown> }>; outputs: Record<string, { node: string }> };
      dispatch: (op: unknown, s?: string, d?: string) => void;
      dispatchAtomic: (ops: unknown[], s?: string, d?: string) => void;
    };
  };
  __basher_selection: { getState: () => { selectMany: (ids: string[]) => void } };
  __basher_gizmo_multi?: () => { count: number; pivot: number[]; pivotMode: string } | null;
  __basher_gizmo_grab: (mode: string, target: [number, number, number]) => void;
}

test('median / active / individual pivot modes drive the multi-gizmo', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as unknown as W).__basher_dag && (window as unknown as W).__basher_selection),
    { timeout: 15000 },
  );
  // n_box → origin; clone it as a second box at [4,0,0]; select both (primary = the clone).
  await page.evaluate(() => {
    const w = window as unknown as W;
    const d = w.__basher_dag.getState();
    const sceneId = d.state.outputs.scene.node;
    const box = d.state.nodes['n_box'];
    d.dispatch({ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [0, 0, 0] }, 'user', 'p');
    const params = { ...(box.params ?? {}), position: [4, 0, 0] };
    d.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'n_box_b', nodeType: box.type, params },
        { type: 'connect', from: { node: 'n_box_b', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
      ],
      'user',
      'add box b',
    );
    w.__basher_selection.getState().selectMany(['n_box', 'n_box_b']);
  });
  await page.waitForTimeout(400);

  // Median (default) → average of the two origins.
  const median = await page.evaluate(() => (window as unknown as W).__basher_gizmo_multi?.() ?? null);
  expect(median).not.toBeNull();
  expect(median!.pivotMode).toBe('median');
  expect(median!.pivot[0]).toBeCloseTo(2, 3);

  // Active → the primary node's origin (the clone at [4,0,0]).
  await page.getByTestId('floating-toolbar-pivot').selectOption('active');
  await page.waitForTimeout(300);
  const active = await page.evaluate(() => (window as unknown as W).__basher_gizmo_multi?.() ?? null);
  expect(active!.pivotMode).toBe('active');
  expect(active!.pivot[0]).toBeCloseTo(4, 3);

  // Individual → a rotate leaves each box at its OWN origin (rotate in place, no orbit).
  await page.getByTestId('floating-toolbar-pivot').selectOption('individual');
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as unknown as W).__basher_gizmo_grab('rotate', [0, 90, 0]));
  await page.waitForTimeout(300);
  const positions = await page.evaluate(() => {
    const n = (window as unknown as W).__basher_dag.getState().state.nodes;
    return { box: n['n_box']?.params?.position as number[], box2: n['n_box_b']?.params?.position as number[] };
  });
  expect(positions.box[0]).toBeCloseTo(0, 2);
  expect(positions.box2[0]).toBeCloseTo(4, 2);
});
