// p1690 (#1690) — in a film with cuts, a new camera from the view is on screen.
//
// Two cameras (the seed and one at x = 20) and a cut to the second at 2 s, through the agent's
// doors. With the playhead at 1 s, the Shots panel's "New camera from this view" is clicked. Before
// #1690 the new camera joined the switch and became its `active`, while the cut keys went on picking
// the other two, so the new view never reached the screen. Now it is cut to at the playhead and the
// panel says so. Read what the viewport DRAWS THROUGH (`__basher_view_camera`) at a time inside
// each shot. Falsifiable: put the old `active` write back and no cut is made, so no toast and the
// middle shot stays on the seed camera.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraOps } from './_splitCamera';

type Ref = { node: string; socket: string };
interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: {
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
        >;
      };
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_setActiveCamera: (id: string) => boolean;
  __basher_dispatchMutator: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: boolean; reason?: string };
  __basher_view_camera: () => { position: [number, number, number] } | null;
}

const CAM2 = 'p1690_cam2';

/** The X of the camera the viewport draws through at `sec`. */
const drawnXAt = (page: Page, sec: number) =>
  page.evaluate(async (s) => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(s);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    return w.__basher_view_camera()!.position[0];
  }, sec);

test('a new camera from the view, in a film with cuts, is cut to at the playhead', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_setActiveCamera &&
      w.__basher_dispatchMutator &&
      w.__basher_view_camera,
    );
  });

  const sel = await page.evaluate(
    ({ ops, cam2 }) => {
      const w = window as unknown as W;
      for (const op of ops) w.__basher_dag.getState().dispatch(op);
      w.__basher_setActiveCamera(cam2);
      w.__basher_setActiveCamera('n_camera');
      const st = w.__basher_dag.getState().state;
      const id = Object.entries(st.nodes).find(([, n]) => n.type === 'CameraSelect')![0];
      const add = w.__basher_dispatchMutator(
        'mutator.timeline.addChannel',
        {
          target: id,
          paramPath: 'active',
          valueType: 'text',
          channelId: 'p1690_cuts',
          initialKeyframe: { time: 0, value: 'n_camera' },
        },
        'cuts',
      );
      if (!add.ok) throw new Error(add.reason);
      const cut = w.__basher_dispatchMutator(
        'mutator.timeline.keyframe',
        { channelId: 'p1690_cuts', time: 2, value: cam2 },
        'cut at 2',
      );
      if (!cut.ok) throw new Error(cut.reason);
      return id;
    },
    {
      ops: splitCameraOps({ objectId: CAM2, position: [20, 2, 8], lookAt: [0, 0.5, 0] }),
      cam2: CAM2,
    },
  );

  // The new camera is made from the editor's own view, so the view must not be looking through.
  await page.evaluate(() =>
    (window as unknown as W).__basher_viewport.getState().setLookThroughCamera(false),
  );
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
  await page.getByTestId('left-sidebar-tab-shots').click();
  await expect(page.locator('[data-testid^="shot-row-"]')).toHaveCount(2);
  await page.getByTestId('shots-camera-from-view').click();

  await expect(page.getByTestId('toast-success')).toContainText(/Cut to .+ at 1\.00 s/);
  await expect(page.locator('[data-testid^="shot-row-"]')).toHaveCount(3);
  const fresh = await page.evaluate((id) => {
    const st = (window as unknown as W).__basher_dag.getState().state;
    const listed = (st.nodes[id].inputs.cameras as Ref[]).map((r) => r.node);
    const node = st.nodes[listed[listed.length - 1]];
    return { id: listed[listed.length - 1], x: (node.params.position as number[])[0] };
  }, sel);
  expect(fresh.id).not.toBe(CAM2);

  await page.evaluate(() =>
    (window as unknown as W).__basher_viewport.getState().setLookThroughCamera(true),
  );
  const seedX = await drawnXAt(page, 0.5);
  expect(seedX).not.toBeCloseTo(fresh.x, 2);
  expect(await drawnXAt(page, 1.5), 'the new view is on screen from the playhead').toBeCloseTo(
    fresh.x,
    2,
  );
  expect(await drawnXAt(page, 2.5), 'the next cut still plays').toBeCloseTo(20, 2);
  await page.screenshot({ path: 'test-results/p1690-new-view-on-screen.png' });
});
