// p315 — the ordered driver stack + mute, pinned on BOTH roads at once: RENDER
// (__basher_mesh_world_position — what actually got drawn) and READ
// (__basher_evaluated_param — what the inspector/compositor resolves).
//
// WHY an e2e for an engine-only slice: the two roads gate mute DIFFERENTLY. The render
// fold drops a muted channel itself (overlayChannels.ts); the read fold does NOT — it has
// no mute filter at all. Mute therefore holds on both roads only because a muted driver is
// dropped at ENUMERATION (paramDrivers.driverStackForTarget). A future refactor that moved
// the bypass back into the fold would still pass the unit tests and would silently mute the
// viewport while the inspector kept reading the driven value (H40, render ≠ read). THIS spec
// is the thing that would catch it — it asserts the two roads agree after every mutation.

import { test, expect } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: { outputs: { scene?: { node: string } } };
    };
  };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_evaluated_param?: (id: string, path: string, ctx?: unknown) => { value: unknown } | null;
}

const A: [number, number, number] = [-4, 0, 0]; // bottom driver's Null
const B: [number, number, number] = [4, 2, 0]; // top driver's Null

/** Both sides of the boundary: what rendered, and what the read side resolved. */
async function observe(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as W;
    return {
      render: w.__basher_mesh_world_position?.('n_box') ?? null,
      read: (w.__basher_evaluated_param?.('n_box', 'position')?.value as number[]) ?? null,
    };
  });
}

test('two vec drivers on n_box.position — the TOP wins, and mute hands over', async ({ page }) => {
  await page.goto('/');
  // The DAG is EMPTY until a project is opened — boot through the starter scene.
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => !!(window as unknown as W).__basher_dag.getState().state.outputs.scene,
  );

  // Seed: two Nulls (the controllers) + two ParamDrivers on the SAME band, orders 0/1.
  await page.evaluate(
    ({ A, B }) => {
      const w = window as unknown as W;
      const d = (op: unknown) => w.__basher_dag.getState().dispatch(op);
      const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
      for (const [id, pos] of [
        ['n_ctlA', A],
        ['n_ctlB', B],
      ] as const) {
        d({ type: 'addNode', nodeId: id, nodeType: 'Null', params: { position: pos } });
        d({
          type: 'connect',
          from: { node: id, socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        });
      }
      for (const [id, ctl, order] of [
        ['n_drvA', 'n_ctlA', 0],
        ['n_drvB', 'n_ctlB', 1],
      ] as const) {
        d({
          type: 'addNode',
          nodeId: id,
          nodeType: 'ParamDriver',
          params: {
            target: 'n_box',
            paramPath: 'position',
            blendMode: 'replace',
            order,
            sourceTransformVec: { node: ctl },
          },
        });
      }
    },
    { A, B },
  );

  // TOP of the stack (order 1 → n_ctlB) owns the band, on BOTH roads.
  await expect.poll(async () => (await observe(page)).render?.[0]).toBeCloseTo(B[0], 1);
  let o = await observe(page);
  expect(o.render?.[1]).toBeCloseTo(B[1], 1);
  expect(o.read?.[0]).toBeCloseTo(B[0], 1); // read agrees with render (H40)

  // MUTE the top driver → the band falls to the one below it. Both roads must move.
  await page.evaluate(() =>
    (window as unknown as W).__basher_dag
      .getState()
      .dispatch({ type: 'setParam', nodeId: 'n_drvB', paramPath: 'mute', value: true }),
  );
  await expect.poll(async () => (await observe(page)).render?.[0]).toBeCloseTo(A[0], 1);
  o = await observe(page);
  expect(o.read?.[0]).toBeCloseTo(A[0], 1); // ← the read road: no mute gate of its own

  // MUTE BOTH → the param falls back to its authored base (no overlay at all).
  await page.evaluate(() =>
    (window as unknown as W).__basher_dag
      .getState()
      .dispatch({ type: 'setParam', nodeId: 'n_drvA', paramPath: 'mute', value: true }),
  );
  await expect.poll(async () => (await observe(page)).read).toBeNull(); // base fallback

  // UN-MUTE the top → it takes the band back (the flag is not one-way).
  await page.evaluate(() => {
    const d = (op: unknown) => (window as unknown as W).__basher_dag.getState().dispatch(op);
    d({ type: 'setParam', nodeId: 'n_drvA', paramPath: 'mute', value: false });
    d({ type: 'setParam', nodeId: 'n_drvB', paramPath: 'mute', value: false });
  });
  await expect.poll(async () => (await observe(page)).render?.[0]).toBeCloseTo(B[0], 1);

  // FLIP the order → the winner flips. This is the fix: the outcome is a function of
  // authored order, not of node-table key order.
  await page.evaluate(() => {
    const d = (op: unknown) => (window as unknown as W).__basher_dag.getState().dispatch(op);
    d({ type: 'setParam', nodeId: 'n_drvA', paramPath: 'order', value: 5 });
  });
  await expect.poll(async () => (await observe(page)).render?.[0]).toBeCloseTo(A[0], 1);
  o = await observe(page);
  expect(o.read?.[0]).toBeCloseTo(A[0], 1);
  console.log('OBSERVED (order flipped → A on top):', JSON.stringify(o));
});
