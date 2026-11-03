// #1773 — a camera shows its held edits, as a cube does. With Auto-Key off, a rotate drag on a
// camera whose rotation is keyed is held (the edit waits to be keyed); before, the edit was held
// and the camera stayed on its keys, so the drag did nothing visible.
//
// Observed on both sides: the held edit in the store, and where the look-through camera looks.

import { expect, test } from './_fixtures';

type V3 = [number, number, number];
interface W {
  __basher_dag: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_autokey: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_transient: {
    getState: () => { get: (n: string, p: string) => { value: unknown } | undefined };
  };
  __basher_camera_gizmo_grab?: (k: 'rotate' | 'translate' | 'aim', t: V3) => void;
  __basher_view_camera: () => { position: V3; direction: V3 } | null;
}

const frames = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );

test('Auto-Key off: a rotate drag on a keyed camera is held, and the camera turns', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_autokey && w.__basher_transient);
  });
  await page.evaluate(() => {
    const w = window as unknown as W;
    if (w.__basher_autokey.getState().enabled) w.__basher_autokey.getState().toggle();
    // Keyed facing −Z (rotation 0): the look-through looks down −Z.
    w.__basher_dag.getState().dispatch({
      type: 'addNode',
      nodeId: 'rot_keys',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'rotation',
        target: 'n_camera',
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [0, 0, 0], easing: 'linear' },
        ],
      },
    });
    w.__basher_viewport.getState().setLookThroughCamera(true);
    w.__basher_selection.getState().select('n_camera');
  });
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_camera_gizmo_grab));
  await frames(page);
  const before = await page.evaluate(() => (window as unknown as W).__basher_view_camera()!);
  [0, 0, -1].forEach((v, i) => expect(before.direction[i], `keyed[${i}]`).toBeCloseTo(v, 3));

  // Turn it 90° about +Y: it should look down −X.
  await page.evaluate(() =>
    (window as unknown as W).__basher_camera_gizmo_grab!('rotate', [0, 90, 0]),
  );
  await frames(page);
  const held = await page.evaluate(() =>
    (window as unknown as W).__basher_transient.getState().get('n_camera', 'rotation'),
  );
  expect(held, 'the drag is held, not keyed').toBeTruthy();
  const after = await page.evaluate(() => (window as unknown as W).__basher_view_camera()!);
  [-1, 0, 0].forEach((v, i) => expect(after.direction[i], `held[${i}]`).toBeCloseTo(v, 3));
});
