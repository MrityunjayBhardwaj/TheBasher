// #1761 — on a camera a point Track-To aims (every camera the v26 step converted), the aim
// reticle moves the Track-To's aim point, in the space the aim point is held in. Before: the
// reticle was read-only on any camera with a constraint, so a saved camera's aim could not be
// dragged at all. A Track-To that follows a node stays read-only — the node decides the aim.
//
// Observed on both sides: the Track-To's aim point in the DAG, and where the look-through camera
// actually looks.

import { expect, test } from './_fixtures';

type V3 = [number, number, number];
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params: Record<string, unknown> }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_camera_gizmo?: () => { bound?: boolean; aim: number[] | null };
  __basher_camera_gizmo_grab?: (k: 'rotate' | 'translate' | 'aim', t: V3) => void;
  __basher_view_camera: () => { position: V3; direction: V3 } | null;
}

/** The default camera, optionally in a Group at `groupAt`, aimed by a point Track-To (`tt`) in
 *  `aimSpace`, selected, looked through. */
async function boot(
  page: import('@playwright/test').Page,
  opts: { aimSpace: 'parent' | 'world'; groupAt?: V3; aimNode?: string },
) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<BasherWindow>;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_viewport);
  });
  await page.evaluate((o) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    if (o.groupAt) {
      dag.dispatch({
        type: 'addNode',
        nodeId: 'grp',
        nodeType: 'Group',
        params: { position: o.groupAt },
      });
      dag.dispatch({
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      });
      dag.dispatch({
        type: 'connect',
        from: { node: 'grp', socket: 'world' },
        to: { node: 'n_camera', socket: 'parent' },
      });
    }
    dag.dispatch({
      type: 'addNode',
      nodeId: 'tt',
      nodeType: 'TrackTo',
      params: {
        target: 'n_camera',
        aimPoint: [0, 0, 0],
        aimSpace: o.aimSpace,
        aimNode: o.aimNode ?? '',
      },
    });
    w.__basher_viewport.getState().setLookThroughCamera(true);
    w.__basher_selection.getState().select('n_camera');
  }, opts);
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_camera_gizmo_grab),
  );
  await page.waitForTimeout(200);
}

const aimPoint = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      (window as unknown as BasherWindow).__basher_dag.getState().state.nodes.tt.params
        .aimPoint as V3,
  );

const grabAim = (page: import('@playwright/test').Page, world: V3) =>
  page.evaluate(async (t) => {
    const w = window as unknown as BasherWindow;
    w.__basher_camera_gizmo_grab!('aim', t);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
  }, world);

const lookDir = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera()!);

const unit = (v: number[]) => {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
};

test('a point Track-To in parent space: the reticle moves its aim point, held in the parent’s space', async ({
  page,
}) => {
  await boot(page, { aimSpace: 'parent', groupAt: [5, 0, 0] });
  const g = await page.evaluate(() => (window as unknown as BasherWindow).__basher_camera_gizmo!());
  expect(g.bound, 'a point aim is draggable').toBe(false);

  // Drag to WORLD (7, 0, 0): with the group at x = 5 that is (2, 0, 0) in the parent's space.
  await grabAim(page, [7, 0, 0]);
  const p = await aimPoint(page);
  [2, 0, 0].forEach((v, i) => expect(p[i], `aimPoint[${i}]`).toBeCloseTo(v, 6));

  // The camera looks at the world point it was dragged to.
  const view = await lookDir(page);
  const want = unit([7 - view.position[0], -view.position[1], -view.position[2]]);
  unit(view.direction).forEach((v, i) => expect(v, `direction[${i}]`).toBeCloseTo(want[i], 3));
});

test('a point Track-To in world space: the reticle writes the world point as is', async ({
  page,
}) => {
  await boot(page, { aimSpace: 'world', groupAt: [5, 0, 0] });
  await grabAim(page, [7, 0, 0]);
  const p = await aimPoint(page);
  [7, 0, 0].forEach((v, i) => expect(p[i], `aimPoint[${i}]`).toBeCloseTo(v, 6));
});

test('control: a Track-To that follows a node keeps the reticle read-only', async ({ page }) => {
  await boot(page, { aimSpace: 'world', aimNode: 'n_box' });
  const g = await page.evaluate(() => (window as unknown as BasherWindow).__basher_camera_gizmo!());
  expect(g.bound).toBe(true);
});
