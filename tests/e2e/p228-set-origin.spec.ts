// #228 Slice D — "Set Origin to Geometry" for a Group (Blender origin.rst). The
// inspector button reads the LIVE scene bounds (useThreeRef) and the pure
// originToGeometry returns a compensated position+pivot so the origin moves to
// the content centre while the geometry stays put. Boundary-pair: drive the REAL
// inspector button and observe the dispatched Group params. (Geometry-fixity +
// the compensation math are unit-tested in setOrigin.test.ts.)

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params?: Record<string, unknown> }>; outputs: Record<string, { node: string }> };
      dispatchAtomic: (ops: unknown[], s?: string, d?: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three?: { getState: () => { scene: unknown } };
}

const grpParams = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const p = (window as unknown as W).__basher_dag.getState().state.nodes['n_grp']?.params as
      | { position: number[]; pivot: number[] }
      | undefined;
    return p ? { position: p.position, pivot: p.pivot } : null;
  });

test('Set Origin to Geometry moves a Group origin to the content centre', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as unknown as W).__basher_dag && (window as unknown as W).__basher_three),
    { timeout: 15000 },
  );
  // Group at origin wrapping the box offset to local [3,0,0] → box renders at
  // world [3,0,0] while the group origin sits at [0,0,0].
  await page.evaluate(() => {
    const w = window as unknown as W;
    const d = w.__basher_dag.getState();
    const sceneId = d.state.outputs.scene.node;
    d.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'n_grp', nodeType: 'Group', params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] } },
        { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [3, 0, 0] },
        { type: 'disconnect', from: { node: 'n_box', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'connect', from: { node: 'n_box', socket: 'out' }, to: { node: 'n_grp', socket: 'children' } },
        { type: 'connect', from: { node: 'n_grp', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
      ],
      'user',
      'nest',
    );
    w.__basher_selection.getState().select('n_grp');
  });
  await page.waitForTimeout(500);

  const before = await grpParams(page);
  expect(before).not.toBeNull();
  expect(before!.position[0]).toBeCloseTo(0, 2);

  await page.getByTestId('npanel-set-origin-geometry').click();
  await page.waitForTimeout(400);

  const after = await grpParams(page);
  // Origin (group position) moved to the box centre ~[3,0,0]; pivot compensated
  // by the same amount so the content world position is unchanged
  // (newPos − newPivot == oldPos − oldPivot, the geometry-fixity invariant).
  expect(after!.position[0]).toBeCloseTo(3, 1);
  expect(after!.position[0] - after!.pivot[0]).toBeCloseTo(before!.position[0] - before!.pivot[0], 2);
});
