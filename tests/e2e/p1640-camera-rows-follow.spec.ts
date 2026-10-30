// #1640 — a keyed camera's Position and aim rows show where the camera is, as a mesh's rows do.
//
// The Position row read the transform seam, which looks a node up among the scene's children; a
// camera hangs off `scene.camera`, so the read came back empty and the row kept the typed value.
// The aim row (a non-transform vector on the lens data) read its evaluated value only when a
// driver bound it, so a KEYED aim kept the typed value too. Both were observed frozen while the
// camera moved: Position 3 against a camera at 6 then 9.
//
// Both sides of the boundary at three scrubbed times: each row (DOM) against the resolver the
// render and the gizmo read (`__basher_world_transform` for the position, the keyed aim's value
// for the aim: linear 0 → 4 over 0..2 s).

import { test, expect } from './_fixtures';

test('a keyed camera’s Position and aim rows follow the camera while scrubbing', async ({
  page,
}) => {
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
        [
          key('p1640_pos', 'n_camera', 'position', [3, 2, 3], [9, 2, 3]),
          key('p1640_aim', 'n_camera_data', 'lookAt', [0, 0, 0], [4, 0, 0]),
        ],
        'user',
        'p1640-seed',
      );
    w.__basher_selection.getState().select('n_camera');
  });
  const posX = page.getByTestId('inspector-vec-n_camera-position-x');
  const aimX = page.getByTestId('inspector-vec-n_camera_data-lookAt-x');
  await expect(posX).toBeVisible();
  await expect(aimX).toBeVisible();

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
    await expect
      .poll(async () => Number(await aimX.inputValue()), { message: `t=${t}: aim row` })
      .toBeCloseTo(2 * t, 3);
  }
});

// #1753 — two more ways the aim row missed the camera. An older project keeps the camera's aim
// keys on the camera Object, not its lens data: the row (drawn against the data) neither knew the
// aim was keyed nor re-rendered as the playhead moved. And with the scene slowed, the row read
// scene time while the camera runs on the playhead.
test('the aim row follows an aim keyed on the camera Object, with the scene at half speed', async ({
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
          nodeId: 'p1753_aim',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'lookAt',
            target: 'n_camera',
            paramPath: 'lookAt',
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
    w.__basher_selection.getState().select('n_camera');
  });
  const aimX = page.getByTestId('inspector-vec-n_camera_data-lookAt-x');
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
