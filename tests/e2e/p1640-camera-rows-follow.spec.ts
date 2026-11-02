// #1640 — a keyed camera's Position row shows where the camera is, as a mesh's rows do.
//
// The Position row read the transform seam, which looks a node up among the scene's children; a
// camera hangs off `scene.camera`, so the read came back empty and the row kept the typed value.
// Observed frozen while the camera moved: Position 3 against a camera at 6 then 9.
//
// Both sides of the boundary at three scrubbed times: the row (DOM) against the resolver the
// render and the gizmo read (`__basher_world_transform`). (#1764 — the camera's aim is no longer
// a lens row: it is a Track-To's aim point, whose row is the second test.)

import { test, expect } from './_fixtures';

test('a keyed camera’s Position row follows the camera while scrubbing', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, unknown>;
    return Boolean(
      w.__basher_dag && w.__basher_selection && w.__basher_time && w.__basher_world_transform,
    );
  });
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_dag: {
        getState: () => { dispatchAtomic: (ops: unknown[], s: string, d: string) => void };
      };
      __basher_selection: { getState: () => { select: (id: string) => void } };
    };
    const key = (id: string, target: string, paramPath: string, a: number[], b: number[]) => ({
      type: 'addNode',
      nodeId: id,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: paramPath,
        target,
        paramPath,
        keyframes: [
          { time: 0, value: a, easing: 'linear' },
          { time: 2, value: b, easing: 'linear' },
        ],
      },
    });
    w.__basher_dag
      .getState()
      .dispatchAtomic(
        [key('p1640_pos', 'n_camera', 'position', [3, 2, 3], [9, 2, 3])],
        'user',
        'p1640-seed',
      );
    w.__basher_selection.getState().select('n_camera');
  });
  const posX = page.getByTestId('inspector-vec-n_camera-position-x');
  await expect(posX).toBeVisible();

  for (const t of [0, 1, 2]) {
    await page.evaluate(
      (t) =>
        (
          window as unknown as {
            __basher_time: { getState: () => { setTime: (s: number) => void } };
          }
        ).__basher_time
          .getState()
          .setTime(t),
      t,
    );
    const drawnX = await page.evaluate(
      (t) =>
        (
          window as unknown as {
            __basher_world_transform: (id: string, ctx: unknown) => { position: number[] } | null;
          }
        ).__basher_world_transform('n_camera', {
          time: { frame: Math.round(t * 30), seconds: t, normalized: 0 },
        })?.position[0] ?? NaN,
      t,
    );
    // The camera moved, so a frozen row cannot pass by matching it.
    expect(drawnX, `t=${t}: the camera is drawn on its keys`).toBeCloseTo(3 + 3 * t, 6);
    await expect
      .poll(async () => Number(await posX.inputValue()), { message: `t=${t}: Position row` })
      .toBeCloseTo(drawnX, 3);
  }
});

// #1753 #1769 #1764 — a camera's aim is its Track-To's aim point. Keyed, its row follows the
// playhead, the camera's clock (a constraint runs on the clock of what it constrains), even with
// the scene slowed to half speed, where scene time would put it at half the value.
test('a camera Track-To’s keyed aim-point row follows the playhead, with the scene at half speed', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, unknown>;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_time);
  });
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_dag: {
        getState: () => {
          state: { outputs: { scene: { node: string } } };
          dispatchAtomic: (ops: unknown[], s: string, d: string) => void;
        };
      };
      __basher_selection: { getState: () => { select: (id: string) => void } };
    };
    const dag = w.__basher_dag.getState();
    dag.dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: dag.state.outputs.scene.node,
          paramPath: 'timeSpeed',
          value: 0.5,
        },
        {
          type: 'addNode',
          nodeId: 'p1753_tt',
          nodeType: 'TrackTo',
          params: { target: 'n_camera', aimPoint: [0, 0, 0] },
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
              { time: 2, value: [4, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p1753-seed',
    );
    w.__basher_selection.getState().select('p1753_tt');
  });
  const aimX = page.getByTestId('inspector-vec-p1753_tt-aimPoint-x');
  await expect(aimX).toBeVisible();
  for (const t of [0, 1, 2]) {
    // `t` is the playhead; the scene is at half of it, and the camera's keys run on the playhead.
    await page.evaluate(
      (t) =>
        (
          window as unknown as {
            __basher_time: { getState: () => { setTime: (s: number) => void } };
          }
        ).__basher_time
          .getState()
          .setTime(t),
      t,
    );
    await expect
      .poll(async () => Number(await aimX.inputValue()), { message: `playhead ${t}: aim row` })
      .toBeCloseTo(2 * t, 3);
  }
});
