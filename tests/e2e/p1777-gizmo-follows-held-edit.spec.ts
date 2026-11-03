// #1777 — a gizmo follows a held edit made in the inspector. With Auto-Key off, typing a new
// position for a keyed object holds the edit (it waits to be keyed) and the object draws there.
// Before, the gizmo stayed on the keyed pose until the playhead moved, so it sat away from the
// object and a drag started from the stale spot.
//
// Observed on both sides: the held edit in the store, and where the gizmo's proxy sits.

import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';
import { splitCubeOps } from './_splitCube';

type V3 = [number, number, number];
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene: { node: string } } };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], source: string, description: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void; selectMany: (ids: string[]) => void };
  };
  __basher_autokey: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_transient: {
    getState: () => {
      get: (n: string, p: string) => { value: unknown } | undefined;
      set: (n: string, p: string, v: unknown) => void;
    };
  };
  __basher_gizmo_multi?: () => { pivot: number[] } | null;
  __basher_gizmo?: () => { position: V3 } | null;
  __basher_camera_gizmo?: () => { position: V3 | null } | null;
}
type Page = import('@playwright/test').Page;

/** `nodeId`'s position keyed at `at` at 0 s and 2 s, Auto-Key off, playhead paused at 1 s,
 *  the node selected and its Transform section open. */
async function boot(page: Page, nodeId: string, at: V3) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_autokey && w.__basher_transient && w.__basher_time);
  });
  await page.evaluate(
    ([id, p]) => {
      const w = window as unknown as W;
      if (w.__basher_autokey.getState().enabled) w.__basher_autokey.getState().toggle();
      w.__basher_dag.getState().dispatch({
        type: 'addNode',
        nodeId: 'pos_keys',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: id,
          paramPath: 'position',
          keyframes: [
            { time: 0, value: p, easing: 'linear' },
            { time: 2, value: p, easing: 'linear' },
          ],
        },
      });
      w.__basher_time.getState().pause();
      w.__basher_time.getState().setTime(1);
      w.__basher_selection.getState().select(id);
    },
    [nodeId, at] as const,
  );
  await openInspectorSection(page, 'transform');
}

async function typeX(page: Page, nodeId: string, x: number) {
  const field = page.getByTestId(`inspector-vec-${nodeId}-position-x`);
  await field.fill(String(x));
  await field.press('Tab');
}

const held = (page: Page, nodeId: string) =>
  page.evaluate(
    (id) => (window as unknown as W).__basher_transient.getState().get(id, 'position'),
    nodeId,
  );

test('a keyed cube: the gizmo moves to a position held from the inspector', async ({ page }) => {
  await boot(page, 'n_box', [0, 0, 0]);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_gizmo?.()?.position[0]))
    .toBeCloseTo(0, 3);
  await typeX(page, 'n_box', 4);
  await expect.poll(() => held(page, 'n_box')).toBeTruthy();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_gizmo?.()?.position[0]))
    .toBeCloseTo(4, 3);
});

test('a keyed camera: its gizmo moves to a position held from the inspector', async ({ page }) => {
  await boot(page, 'n_camera', [3, 2, 3]);
  const camX = () =>
    page.evaluate(() => (window as unknown as W).__basher_camera_gizmo?.()?.position?.[0]);
  await expect.poll(camX).toBeCloseTo(3, 3);
  await typeX(page, 'n_camera', 6);
  await expect.poll(() => held(page, 'n_camera')).toBeTruthy();
  await expect.poll(camX).toBeCloseTo(6, 3);
});

test('two objects selected: the shared gizmo moves when one of them holds an edit', async ({
  page,
}) => {
  await boot(page, 'n_box', [0, 0, 0]);
  // A second cube at [4, 0, 0]: the shared gizmo sits between them, at [2, 0, 0].
  await page.evaluate(
    (ops) => {
      const w = window as unknown as W;
      const dag = w.__basher_dag.getState();
      dag.dispatchAtomic(
        [
          ...ops,
          {
            type: 'connect',
            from: { node: 'n_box_b', socket: 'out' },
            to: { node: dag.state.outputs.scene.node, socket: 'children' },
          },
        ],
        'user',
        'add box b',
      );
      w.__basher_selection.getState().selectMany(['n_box', 'n_box_b']);
    },
    splitCubeOps({ objectId: 'n_box_b', position: [4, 0, 0] }),
  );
  const pivotX = () =>
    page.evaluate(() => (window as unknown as W).__basher_gizmo_multi?.()?.pivot[0]);
  await expect.poll(pivotX).toBeCloseTo(2, 3);
  // Hold n_box at [8, 0, 0] (the store an inspector edit with Auto-Key off writes to).
  await page.evaluate(() =>
    (window as unknown as W).__basher_transient.getState().set('n_box', 'position', [8, 0, 0]),
  );
  await expect.poll(pivotX).toBeCloseTo(6, 3);
});
