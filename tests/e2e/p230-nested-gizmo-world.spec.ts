// #230 — the transform gizmo on a GROUP-NESTED child must operate in WORLD space:
// it must SEED at the child's rendered world pose (not its local pose, detached by
// the parent transform) AND convert a world-space drag back to the child's LOCAL
// params. Top-level children must stay byte-identical (parent identity).
//
// Boundary-pair: side A = the REAL committed gizmo proxy (`__basher_gizmo()`),
// side B = the child's LOCAL params after a world-space grab (`__basher_gizmo_grab`
// drives the actual onObjectChange path). The bug (pre-fix): the gizmo sat at the
// child's LOCAL [0,0,0] while it rendered at world [5,1,0].

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }>; nodes: Record<string, { params?: { position?: number[] } }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_gizmo?: () => { position: number[]; rotation: number[]; scale: number[] } | null;
  __basher_gizmo_grab: (mode: string, target: [number, number, number]) => void;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as unknown as BasherWindow).__basher_dag && (window as unknown as BasherWindow).__basher_selection),
    { timeout: 15000 },
  );
});

test('gizmo on a Group-nested child anchors in WORLD space and writes LOCAL params', async ({ page }) => {
  // Nest the default n_box under a Group translated to [5,1,0]. The box keeps its
  // own local [0,0,0], so it RENDERS at world [5,1,0].
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'n_grp_nest', nodeType: 'Group', params: { position: [5, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] } },
        { type: 'disconnect', from: { node: 'n_box', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'connect', from: { node: 'n_box', socket: 'out' }, to: { node: 'n_grp_nest', socket: 'children' } },
        { type: 'connect', from: { node: 'n_grp_nest', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
      ],
      'user',
      'nest box under group',
    );
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as unknown as BasherWindow).__basher_selection.getState().select('n_box'));
  await page.waitForTimeout(500);

  // SIDE A — the gizmo must sit at the child's WORLD pose [5,1,0] (the fix).
  const seed = await page.evaluate(() => (window as unknown as BasherWindow).__basher_gizmo?.() ?? null);
  expect(seed).not.toBeNull();
  expect(seed!.position[0]).toBeCloseTo(5, 3);
  expect(seed!.position[1]).toBeCloseTo(1, 3);
  expect(seed!.position[2]).toBeCloseTo(0, 3);

  // SIDE B — drag (translate) to WORLD [8,1,0]; the write-back must store the
  // child's LOCAL position [3,0,0] (world − parent), not the world value.
  await page.evaluate(() => (window as unknown as BasherWindow).__basher_gizmo_grab('translate', [8, 1, 0]));
  await page.waitForTimeout(300);
  const local = await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag.getState().state.nodes['n_box']?.params?.position ?? null);
  expect(local).not.toBeNull();
  expect(local![0]).toBeCloseTo(3, 3);
  expect(local![1]).toBeCloseTo(0, 3);
  expect(local![2]).toBeCloseTo(0, 3);
});

test('top-level child stays byte-identical (world == local, no conversion)', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'n_box_top', nodeType: 'BoxMesh', params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { type: 'connect', from: { node: 'n_box_top', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
      ],
      'user',
      'top box',
    );
    w.__basher_selection.getState().select('n_box_top');
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => (window as unknown as BasherWindow).__basher_gizmo_grab('translate', [2, 0, 0]));
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return {
      param: w.__basher_dag.getState().state.nodes['n_box_top']?.params?.position ?? null,
      gizmo: w.__basher_gizmo?.() ?? null,
    };
  });
  // A top-level child writes the world target verbatim as its local params and the
  // gizmo sits there — no parent inverse applied.
  expect(result.param![0]).toBeCloseTo(2, 3);
  expect(result.gizmo!.position[0]).toBeCloseTo(2, 3);
});
