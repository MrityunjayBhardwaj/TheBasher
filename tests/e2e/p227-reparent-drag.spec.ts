// #227 Slice 1 — reparent via drag in the outliner. Dragging a row onto a Group
// (or the Scene root) moves the node into that parent's `children` list
// (disconnect old + connect new); dragging between same-parent siblings still
// reorders (the original behavior). Cycle-guarded: a node can't be dropped into
// itself or a descendant. Selection/scene stay consistent with the DAG (V1/V8).
//
// HTML5 DnD is driven by dispatching dragstart→dragover→drop with ONE shared
// DataTransfer so the dragstart's setData survives to the drop handler.

import { expect, test } from './_fixtures';
import { splitCubeOps } from './_splitCube';
import type { Page, JSHandle } from '@playwright/test';

interface ReparentWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: Record<string, { node: string }>;
        nodes: Record<string, { inputs: { children?: { node: string }[] } }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_world_transform: (id: string) => { position: [number, number, number] } | null;
}

const childIds = (page: Page, nodeId: string) =>
  page.evaluate((id) => {
    const s = (window as unknown as ReparentWindow).__basher_dag.getState().state;
    const node = id === '__scene__' ? s.nodes[s.outputs.scene.node] : s.nodes[id];
    return (node.inputs.children ?? []).map((c) => c.node);
  }, nodeId);

async function dragRowOnto(page: Page, srcId: string, dstId: string) {
  const dt: JSHandle = await page.evaluateHandle(() => new DataTransfer());
  const src = page.locator(`[data-testid="scene-tree-row-${srcId}"]`);
  const dst = page.locator(`[data-testid="scene-tree-row-${dstId}"]`);
  await src.dispatchEvent('dragstart', { dataTransfer: dt });
  await dst.dispatchEvent('dragover', { dataTransfer: dt });
  await dst.dispatchEvent('drop', { dataTransfer: dt });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as ReparentWindow).__basher_dag), {
    timeout: 15000,
  });
});

test('drag a top-level node INTO a Group reparents it (DAG + rendered world)', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as ReparentWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_grp',
          nodeType: 'Group',
          params: { position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        {
          type: 'connect',
          from: { node: 'n_grp', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
      ],
      'user',
      'add group',
    );
  });

  expect(
    await page.evaluate(() => {
      const w = window as unknown as ReparentWindow;
      return w.__basher_world_transform('n_box')?.position?.[0];
    }),
  ).toBeCloseTo(0, 3);

  await dragRowOnto(page, 'n_box', 'n_grp');

  expect(await childIds(page, '__scene__')).not.toContain('n_box');
  expect(await childIds(page, 'n_grp')).toContain('n_box');
  // The box now inherits the group's world transform → its origin sits at [5,0,0].
  const x = await page.evaluate(
    () => (window as unknown as ReparentWindow).__basher_world_transform('n_box')?.position?.[0],
  );
  expect(x).toBeCloseTo(5, 3);
});

test('drag a nested node onto the Scene root un-parents it back to top level', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as ReparentWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    // Group already containing the box.
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_grp',
          nodeType: 'Group',
          params: { position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        {
          type: 'connect',
          from: { node: 'n_grp', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_grp', socket: 'children' },
        },
      ],
      'user',
      'group the box',
    );
  });
  expect(await childIds(page, 'n_grp')).toContain('n_box');

  const sceneId = await page.evaluate(
    () => (window as unknown as ReparentWindow).__basher_dag.getState().state.outputs.scene.node,
  );
  await dragRowOnto(page, 'n_box', sceneId);

  expect(await childIds(page, 'n_grp')).not.toContain('n_box');
  expect(await childIds(page, '__scene__')).toContain('n_box');
});

test('a Group cannot be dropped into its own descendant (cycle guard)', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as ReparentWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    // n_outer ⊃ n_inner (both Groups).
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_outer',
          nodeType: 'Group',
          params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        {
          type: 'addNode',
          nodeId: 'n_inner',
          nodeType: 'Group',
          params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        {
          type: 'connect',
          from: { node: 'n_outer', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'n_inner', socket: 'out' },
          to: { node: 'n_outer', socket: 'children' },
        },
      ],
      'user',
      'nested groups',
    );
  });

  // Drop n_outer onto n_inner (its child) → must be a no-op.
  await dragRowOnto(page, 'n_outer', 'n_inner');

  expect(await childIds(page, '__scene__')).toContain('n_outer');
  expect(await childIds(page, 'n_outer')).toContain('n_inner');
  expect(await childIds(page, 'n_inner')).not.toContain('n_outer');
});

test('same-parent sibling drag still REORDERS (regression)', async ({ page }) => {
  await page.evaluate(
    ({ ops }) => {
      const w = window as unknown as ReparentWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene.node;
      dag.dispatchAtomic(
        [
          ...ops,
          {
            type: 'connect',
            from: { node: 'n_box_b', socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'user',
        'add second box',
      );
    },
    { ops: splitCubeOps({ objectId: 'n_box_b', position: [3, 0, 0] }) },
  );
  // Order is [n_box, n_box_b]. Drag n_box_b onto n_box → swap to [n_box_b, n_box].
  expect(await childIds(page, '__scene__')).toEqual(['n_box', 'n_box_b']);
  await dragRowOnto(page, 'n_box_b', 'n_box');
  expect(await childIds(page, '__scene__')).toEqual(['n_box_b', 'n_box']);
});
