// #1772 — clearing a camera's look-at target keeps it looking where it looked even when its
// rotation is keyed. Before: the frozen rotation was a plain write, the keys won the moment the
// Track-To was gone, and the camera jumped to its keyed orientation. Now the frozen rotation is
// written as every edit to an animated param is: a key at this frame with Auto-Key on, a held
// edit with it off.
//
// Observed on both sides: where the look-through camera looks, and what landed in the keys / the
// held edit.

import { expect, test } from './_fixtures';
import { dataNodeIdOf } from './_seedNodes';

type V3 = [number, number, number];
interface Key {
  time: number;
  value: number[];
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_autokey: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_transient: {
    getState: () => { get: (n: string, p: string) => { value: unknown } | undefined };
  };
  __basher_camera_gizmo_grab?: unknown;
  __basher_view_camera: () => { position: V3; direction: V3 } | null;
}

const KEYED: V3 = [0, 90, 0];

/** The default camera, aimed at the cube through the inspector dropdown, its rotation keyed to
 *  `KEYED` (hidden by the Track-To), looked through. */
async function boot(page: import('@playwright/test').Page, autoKey: boolean) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_autokey && w.__basher_transient);
  });
  await page.evaluate(
    ([on, keyed]) => {
      const w = window as unknown as W;
      if (w.__basher_autokey.getState().enabled !== on) w.__basher_autokey.getState().toggle();
      w.__basher_dag.getState().dispatch({
        type: 'addNode',
        nodeId: 'rot_keys',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'rotation',
          target: 'n_camera',
          paramPath: 'rotation',
          keyframes: [
            { time: 0, value: keyed, easing: 'linear' },
            { time: 2, value: keyed, easing: 'linear' },
          ],
        },
      });
      w.__basher_viewport.getState().setLookThroughCamera(true);
      w.__basher_selection.getState().select('n_camera');
    },
    [autoKey, KEYED] as const,
  );
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_camera_gizmo_grab));
  const lens = await dataNodeIdOf(page, 'n_camera');
  const picker = `[data-testid="inspector-camera-lookat-${lens}"]`;
  await page.selectOption(picker, 'n_box');
  await frames(page);
  return picker;
}

const frames = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );

const look = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as W).__basher_view_camera()!.direction);

const unit = (v: number[]) => {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
};

const sameDirection = (a: number[], b: number[], label: string) =>
  unit(a).forEach((v, i) => expect(v, `${label}[${i}]`).toBeCloseTo(unit(b)[i], 3));

test('Auto-Key on: the clear keys the rotation it froze, and the camera does not jump', async ({
  page,
}) => {
  const picker = await boot(page, true);
  const aimed = await look(page);
  await page.selectOption(picker, '');
  await frames(page);
  sameDirection(await look(page), aimed, 'direction after clear');
  // The key at this frame holds the frozen rotation, not the old keyed one.
  const keys = await page.evaluate(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes.rot_keys.params
        .keyframes as Key[],
  );
  const k0 = keys.find((k) => Math.abs(k.time) < 1e-9)!;
  expect(k0.value).not.toEqual(KEYED);
});

test('Auto-Key off: the clear holds the frozen rotation as a pending edit', async ({ page }) => {
  const picker = await boot(page, false);
  const aimed = await look(page);
  await page.selectOption(picker, '');
  await frames(page);
  const held = await page.evaluate(() =>
    (window as unknown as W).__basher_transient.getState().get('n_camera', 'rotation'),
  );
  expect(held, 'a held edit on the rotation').toBeTruthy();
  expect(held!.value).not.toEqual(KEYED);
  // No key was written: the keys still hold the old rotation until this edit is keyed.
  const keys = await page.evaluate(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes.rot_keys.params
        .keyframes as Key[],
  );
  expect(keys[0].value).toEqual(KEYED);
  // …and the camera shows the held edit, as a cube does (#1773): it does not jump.
  sameDirection(await look(page), aimed, 'direction after clear');
});
