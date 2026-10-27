// p1688 (#1688) — a camera rig set to the film clock carries its camera at the playhead.
//
// The scene runs at half speed. A rig Group, keyed from x = 0 at 0 s to x = 8 at 4 s, carries a
// camera, and the viewport looks through it. At 2 s of the playhead the scene has reached 1 s, so
// a rig on scene time has carried the camera to x = 2. Set the rig's `clock` to 'film' and it plays
// at the playhead: x = 4, the camera riding it the way Blender's own camera rigs carry theirs.
// Read off what the viewport DRAWS THROUGH (`__basher_view_camera`). Falsifiable: read the rig at
// scene time whatever its clock says and the second reading stays at 2.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraDataId, splitCameraOps } from './_splitCamera';

interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown, source?: string, desc?: string) => void;
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { params: Record<string, unknown> }>;
      };
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_setActiveCamera: (id: string) => boolean;
  __basher_view_camera: () => { position: [number, number, number] } | null;
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_camera_gizmo_grab?: (kind: 'aim', target: [number, number, number]) => void;
}

/** The X of the camera the viewport draws through at playhead `sec`, once it has settled. */
async function drawnXAt(page: Page, sec: number, near: number): Promise<number> {
  await page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), sec);
  let x = NaN;
  await expect
    .poll(async () => {
      x = await page.evaluate(() => (window as unknown as W).__basher_view_camera()!.position[0]);
      return Math.abs(x - near) < 0.05;
    })
    .toBe(true);
  return x;
}

/** A half-speed scene with a rig keyed from x = 0 (0 s) to x = 8 (4 s) carrying a camera. */
async function rigWithCamera(page: Page, rigClock?: 'film'): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_setActiveCamera && w.__basher_view_camera);
  });
  await page.evaluate(
    ({ camOps, rigClock }) => {
      const w = window as unknown as W;
      const scene = w.__basher_dag.getState().state.outputs.scene!.node;
      const ops: unknown[] = [
        { type: 'setParam', nodeId: scene, paramPath: 'timeSpeed', value: 0.5 },
        { type: 'addNode', nodeId: 'p1688_rig', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'p1688_rig', socket: 'out' },
          to: { node: scene, socket: 'children' },
        },
        ...camOps,
        {
          type: 'connect',
          from: { node: 'p1688_cam', socket: 'out' },
          to: { node: 'p1688_rig', socket: 'children' },
        },
        ...(rigClock
          ? [{ type: 'setParam', nodeId: 'p1688_rig', paramPath: 'clock', value: rigClock }]
          : []),
        {
          type: 'addNode',
          nodeId: 'p1688_rig_x',
          nodeType: 'KeyframeChannelVec3',
          params: {
            target: 'p1688_rig',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 4, value: [8, 0, 0], easing: 'linear' },
            ],
          },
        },
      ];
      for (const op of ops) w.__basher_dag.getState().dispatch(op, 'user', 'p1688');
      w.__basher_setActiveCamera('p1688_cam');
    },
    {
      camOps: splitCameraOps({ objectId: 'p1688_cam', position: [0, 1, 6], lookAt: [0, 0, 0] }),
      rigClock,
    },
  );
}

test('a rig set to the film clock carries its camera at the playhead in a slowed scene', async ({
  page,
}) => {
  await rigWithCamera(page);
  await page.evaluate(() =>
    (window as unknown as W).__basher_viewport.getState().setLookThroughCamera(true),
  );

  expect(await drawnXAt(page, 2, 2), 'a rig on scene time').toBeCloseTo(2, 1);

  await page.evaluate(() =>
    (window as unknown as W).__basher_dag
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: 'p1688_rig', paramPath: 'clock', value: 'film' },
        'user',
        'rig on film',
      ),
  );
  expect(await drawnXAt(page, 2, 4), 'the rig set to film').toBeCloseTo(4, 1);
  await page.screenshot({ path: 'test-results/p1688-rig-on-film.png' });
});

// The camera gizmo writes the aim in the camera's LOCAL space, so it undoes the rig's world. At 2 s
// of the playhead a scene-time rig stands at x = 2 and a film-time rig at x = 4 — where they are
// drawn. Aim at world x = 10 and the written local aim is 10 minus that. Falsifiable: hand the
// gizmo's parent read the playhead as if it were scene time, and the rig is read at x = 4 (scene
// rig) or x = 8 (film rig), and the local aim comes out 6 or 2.
for (const rigClock of [undefined, 'film'] as const) {
  const rigX = rigClock ? 4 : 2;
  test(`the camera gizmo undoes the rig where it is drawn (rig ${rigClock ?? 'on scene time'})`, async ({
    page,
  }) => {
    await rigWithCamera(page, rigClock);
    await page.evaluate(() => {
      const w = window as unknown as W;
      w.__basher_time.getState().setTime(2);
      w.__basher_selection.getState().select('p1688_cam');
    });
    await page.waitForFunction(() => Boolean((window as unknown as W).__basher_camera_gizmo_grab));
    // The gizmo seeds from the camera at the playhead; let it re-seed at 2 s.
    await page.waitForTimeout(200);
    await page.evaluate(() =>
      (window as unknown as W).__basher_camera_gizmo_grab!('aim', [10, 0, 0]),
    );
    let lookAt: number[] = [];
    await expect
      .poll(async () => {
        lookAt = await page.evaluate(
          (data) =>
            (window as unknown as W).__basher_dag.getState().state.nodes[data].params
              .lookAt as number[],
          splitCameraDataId('p1688_cam'),
        );
        return lookAt[0] !== 0;
      })
      .toBe(true);
    expect(lookAt[0], 'world aim 10 minus the drawn rig').toBeCloseTo(10 - rigX, 2);
  });
}
