// p1753 (#1753) — a camera's rotation, as a driver reads it, is the orientation the camera is drawn
// with. A camera is turned by its winning Track-To, else by its own rotation (#1760); the read
// used to return the Object's typed rotation even while an aim turned the drawn camera.
// Compared with what is DRAWN: the look-through camera's world forward (`__basher_view_camera`),
// with the scene slowed so the camera (on the playhead) and the scene are at different times.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

test.setTimeout(120_000);

type V3 = [number, number, number];
interface Ctx {
  time: { frame: number; seconds: number; normalized: number };
  scene: number;
  film: number;
}
interface W {
  __basher_dag: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_view_camera: () => { direction: V3 } | null;
  __basher_evaluated_transform: (id: string, ctx: Ctx) => { rotation: V3 | null } | null;
  __basher_evaluated_param: (id: string, path: string, ctx: Ctx) => { value: unknown } | null;
}

async function boot(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(
      w.__basher_dag && w.__basher_view_camera && w.__basher_evaluated_transform && w.__basher_time,
    );
  });
}

/** The world forward (-Z) of an XYZ euler in degrees, three's order (R = Rx · Ry · Rz). */
function forwardOf([x, y]: V3): V3 {
  // Rz turns about the view axis, so the forward does not depend on it.
  const [a, b] = [x, y].map((d) => (d * Math.PI) / 180);
  // R · (0, 0, -1) = −(third column of Rx·Ry·Rz).
  return [-Math.sin(b), Math.sin(a) * Math.cos(b), -Math.cos(a) * Math.cos(b)];
}

test('a driver reading a camera’s rotation reads where the camera looks', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const ops = [
      { type: 'setParam', nodeId: 'n_scene', paramPath: 'timeSpeed', value: 0.5 },
      { type: 'setParam', nodeId: 'n_camera', paramPath: 'position', value: [0, 0, 5] },
      // A typed rotation the aim overrides: the read must not return it.
      { type: 'setParam', nodeId: 'n_camera', paramPath: 'rotation', value: [10, 20, 30] },
      // #1760 — aimed as a saved camera is since v26: a point Track-To in its parent's space,
      // its aim point keyed. #1769 — those keys run on the playhead, as the camera does.
      {
        type: 'addNode',
        nodeId: 'p1753_tt',
        nodeType: 'TrackTo',
        params: { target: 'n_camera', aimPoint: [0, 0, 0], aimSpace: 'parent' },
      },
      {
        type: 'addNode',
        nodeId: 'p1753_aim',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'aimPoint',
          target: 'p1753_tt',
          paramPath: 'aimPoint',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 2, value: [10, 0, 5], easing: 'linear' },
          ],
        },
      },
      // The light's intensity follows the camera's yaw: −180…0° → 0…3, so −90° reads 1.5.
      {
        type: 'addNode',
        nodeId: 'p1753_driver',
        nodeType: 'ParamDriver',
        params: {
          target: 'n_light_data',
          paramPath: 'intensity',
          sourceTransform: {
            node: 'n_camera',
            channel: 'ry',
            remap: { inMin: -180, inMax: 0, outMin: 0, outMax: 3 },
          },
        },
      },
    ];
    for (const op of ops) dag.dispatch(op);
    (window as unknown as W).__basher_viewport.getState().setLookThroughCamera(true);
  });

  // Playhead 2 s: the camera has turned to look down +X; the scene is at 1 s.
  const seen = await page.evaluate(async () => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(2);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    const ctx = { time: { frame: 60, seconds: 1, normalized: 0 }, scene: 1, film: 2 };
    return {
      drawn: w.__basher_view_camera()!.direction,
      rotation: w.__basher_evaluated_transform('n_camera', ctx)!.rotation!,
      intensity: w.__basher_evaluated_param('n_light_data', 'intensity', ctx)?.value,
    };
  });
  console.log(`p1753 ${JSON.stringify(seen)}`);
  expect(seen.drawn[0], 'the drawn camera looks down +X').toBeCloseTo(1, 3);
  const fwd = forwardOf(seen.rotation);
  fwd.forEach((v, i) => expect(v, `read forward[${i}] = drawn`).toBeCloseTo(seen.drawn[i], 3));
  expect(seen.intensity, 'the driver reads the drawn yaw').toBeCloseTo(1.5, 3);
});
