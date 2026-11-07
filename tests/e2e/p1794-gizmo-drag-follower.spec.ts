// #1794 — dragging an object on a Follow Path with the gizmo moves it by the drag. The gizmo sits
// where the object is drawn (on the path); a drag adds to the object's OWN position, its offset
// from the path since #1791, as Blender's grab does. Before, the drawn point was written back as
// the own position, so the offset doubled and the object jumped by the whole path.
//
// Observed on both sides: the own position in the DAG, and where the cube is drawn.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCubeOps } from './_splitCube';

type V3 = [number, number, number];
interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params: { position?: V3 } }> };
      dispatchAtomic: (ops: unknown[], source: string, description: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void; selectMany: (ids: string[]) => void };
  };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_autokey: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_gizmo_grab?: (mode: string, target: V3) => void;
  __basher_gizmo?: () => { position: V3 } | null;
  __basher_gizmo_multi?: () => { pivot: number[] } | null;
  __basher_mesh_world_position: (id: string) => number[] | null;
}

const OWN: V3 = [0, 2, 0];
const PATH_END: V3 = [12, 0, 0];

/** n_box at its own (0, 2, 0) on a path from the origin to (12, 0, 0), at its end: drawn at
 *  (12, 2, 0). Auto-Key off, paused at 0. */
async function boot(page: Page, extraOps: unknown[] = []) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_mesh_world_position);
  });
  await page.evaluate(
    ({ own, end, extra }) => {
      const w = window as unknown as W;
      if (w.__basher_autokey.getState().enabled) w.__basher_autokey.getState().toggle();
      w.__basher_time.getState().pause();
      w.__basher_time.getState().setTime(0);
      w.__basher_dag.getState().dispatchAtomic(
        [
          { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: own },
          {
            type: 'addNode',
            nodeId: 'crv_data',
            nodeType: 'CurveData',
            params: {
              points: [
                { id: 'p0', co: [0, 0, 0] },
                { id: 'p1', co: end },
              ],
              closed: false,
              resolution: 32,
            },
          },
          { type: 'addNode', nodeId: 'crv', nodeType: 'Object', params: {} },
          {
            type: 'connect',
            from: { node: 'crv_data', socket: 'out' },
            to: { node: 'crv', socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: 'crv', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
          {
            type: 'addNode',
            nodeId: 'fp',
            nodeType: 'FollowPath',
            params: { name: 'fp', target: 'n_box', curve: 'crv', evalTime: 1, offset: 0 },
          },
          ...extra,
        ],
        'user',
        'p1794 setup',
      );
    },
    { own: OWN, end: PATH_END, extra: extraOps },
  );
  // The premise: the cube draws at the path's end plus its own offset.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_mesh_world_position('n_box')))
    .toEqual([12, 2, 0]);
}

const own = (page: Page) =>
  page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.nodes.n_box.params.position,
  );
const drawn = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_position('n_box'));

const close = (
  got: readonly number[] | null | undefined,
  want: readonly number[],
  what: string,
) => {
  expect(got, what).toBeTruthy();
  want.forEach((v, i) => expect(got![i], `${what}[${i}]`).toBeCloseTo(v, 4));
};

test('one object: a 1-unit drag along X adds 1 to its own position', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().select('n_box'));
  // The gizmo sits where the cube is drawn, on the path.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_gizmo?.()?.position ?? null))
    .toEqual([12, 2, 0]);
  await page.evaluate(() => (window as unknown as W).__basher_gizmo_grab!('translate', [13, 2, 0]));
  await expect.poll(async () => (await own(page))?.[0]).toBeCloseTo(1, 4);
  close(await own(page), [1, 2, 0], 'own position');
  await expect.poll(async () => (await drawn(page))?.[0]).toBeCloseTo(13, 4);
  close(await drawn(page), [13, 2, 0], 'drawn');
});

test('two objects: a 1-unit shared drag adds 1 to the follower’s own position', async ({
  page,
}) => {
  await boot(page, [
    ...splitCubeOps({ objectId: 'n_box_b', position: [0, 0, 4] }),
    {
      type: 'connect',
      from: { node: 'n_box_b', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ]);
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection.getState().selectMany(['n_box', 'n_box_b']),
  );
  // Median of the drawn origins (12, 2, 0) and (0, 0, 4).
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__basher_gizmo_multi?.()?.pivot ?? null),
    )
    .toEqual([6, 1, 2]);
  await page.evaluate(() => (window as unknown as W).__basher_gizmo_grab!('translate', [7, 1, 2]));
  await expect.poll(async () => (await own(page))?.[0]).toBeCloseTo(1, 4);
  close(await own(page), [1, 2, 0], 'own position');
  close(await drawn(page), [13, 2, 0], 'drawn');
});

// #1813 — a drag that goes nowhere changes nothing. The handle sits where the chain ends and the
// write goes to the own transform, so this is the shortest test that the two aren't confused.
test('a zero-length drag on a followed object leaves its own position', async ({ page }) => {
  await boot(page);
  const own = await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_selection.getState().select('n_box');
    return w.__basher_dag.getState().state.nodes.n_box.params.position;
  });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_gizmo_grab && w.__basher_gizmo?.());
  });
  const after = await page.evaluate(() => {
    const w = window as unknown as W;
    const here = w.__basher_gizmo!()!.position;
    w.__basher_gizmo_grab!('translate', here);
    return w.__basher_dag.getState().state.nodes.n_box.params.position;
  });
  expect(after).toEqual(own);
});
