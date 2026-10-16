// p1594 (#1594) — one speed for the whole scene (bullet time), while the camera keeps real time.
//
// The box, the key light and the camera each travel X 0 → 8 over 0..4 s. At speed 1 all three
// are at X 4 at the 2 s playhead. With the Scene's speed set to 0.25 from the Timebar, the box
// and the light (scene things) have covered a quarter of that — scene time is 0.5 s — while
// the look-through camera (film time) is still at X 4. Read off what is DRAWN (the meshes, the
// three light, the view camera), not off the graph.
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_time: {
    getState: () => {
      setTime: (s: number) => void;
      play: () => void;
      pause: () => void;
      seconds: number;
      filmSeconds: number;
    };
  };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_light_world_positions?: () => [number, number, number][];
  __basher_view_camera?: () => { position: [number, number, number] } | null;
}

const travel = (id: string, target: string, y: number, z: number) => ({
  type: 'addNode',
  nodeId: id,
  nodeType: 'KeyframeChannelVec3',
  params: {
    name: 'position',
    target,
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, y, z], easing: 'linear' },
      { time: 4, value: [8, y, z], easing: 'linear' },
    ],
  },
});

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_viewport &&
      w.__basher_mesh_world_position?.('n_box') &&
      w.__basher_view_camera,
    );
  });
  await page.evaluate(
    (ops) => {
      const w = window as unknown as W;
      w.__basher_dag.getState().dispatchAtomic(ops, 'user', 'p1594-seed');
      w.__basher_viewport.getState().setLookThroughCamera(true);
    },
    [
      travel('p1594_box', 'n_box', 0, 0),
      travel('p1594_light', 'n_light', 5, 3),
      travel('p1594_cam', 'n_camera', 2, 6),
    ],
  );
}

/** What is drawn at film time `s`: box X, key-light X, look-through camera X, and both clocks. */
async function drawnAt(page: import('@playwright/test').Page, s: number) {
  await page.evaluate((sec) => (window as unknown as W).__basher_time.getState().setTime(sec), s);
  // Two animation frames, so every per-frame follower has run at the new playhead.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  return page.evaluate(() => {
    const w = window as unknown as W;
    const t = w.__basher_time.getState();
    return {
      box: w.__basher_mesh_world_position!('n_box')![0],
      // The key light by its fixed Y/Z (an ambient light sits at the origin too).
      light: w.__basher_light_world_positions!().find(
        (p) => Math.abs(p[1] - 5) < 1e-3 && Math.abs(p[2] - 3) < 1e-3,
      )![0],
      camera: w.__basher_view_camera!()!.position[0],
      scene: t.seconds,
      film: t.filmSeconds,
    };
  });
}

test('the Speed field slows every keyed thing in the scene together; the camera keeps real time', async ({
  page,
}) => {
  await boot(page);

  // Speed 1: one clock. Everything is halfway at the 2 s playhead.
  const real = await drawnAt(page, 2);
  expect(real.scene).toBeCloseTo(2, 6);
  expect(real.box).toBeCloseTo(4, 3);
  expect(real.light).toBeCloseTo(4, 3);
  expect(real.camera).toBeCloseTo(4, 3);

  // One edit, from the Timebar: speed 0.25.
  const speed = page.getByTestId('timebar-speed');
  await speed.fill('0.25');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
        return Object.values(nodes).find((n) => n.type === 'Scene')?.params.timeSpeed;
      }),
    )
    .toBe(0.25);

  const slow = await drawnAt(page, 2);
  expect(slow.film).toBeCloseTo(2, 6);
  expect(slow.scene).toBeCloseTo(0.5, 6);
  // The box and the light slowed together: a quarter of the way they were.
  expect(slow.box).toBeCloseTo(1, 3);
  expect(slow.light).toBeCloseTo(1, 3);
  // The camera did not.
  expect(slow.camera).toBeCloseTo(4, 3);
});

test('playback: the playhead runs in real time while the slowed scene crawls', async ({ page }) => {
  await boot(page);
  await page.getByTestId('timebar-speed').fill('0.1');
  await page.evaluate(() => {
    const t = (window as unknown as W).__basher_time.getState();
    t.setTime(0);
    t.play();
  });
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => {
    const w = window as unknown as W;
    const t = w.__basher_time.getState();
    t.pause();
    return {
      film: t.filmSeconds,
      scene: t.seconds,
      box: w.__basher_mesh_world_position!('n_box')![0],
      camera: w.__basher_view_camera!()!.position[0],
    };
  });
  // About a second of playhead, a tenth of that in the scene.
  expect(after.film).toBeGreaterThan(0.5);
  expect(after.scene).toBeCloseTo(after.film * 0.1, 3);
  // The camera covered ten times the box's distance.
  expect(after.camera).toBeGreaterThan(after.box * 5);
});

test("the Speed diamond keys the speed at the playhead's time, and the key ramps the scene", async ({
  page,
}) => {
  await boot(page);
  const diamond = page.getByTestId('timebar-speed-diamond');
  // Key 1 at 1 s, then 0.05 at 1.5 s: real time, then near-frozen.
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
  await diamond.click();
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1.5));
  await page.getByTestId('timebar-speed').fill('0.05');
  await diamond.click();

  const keys = await page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const ch = Object.values(nodes).find(
      (n) => n.type === 'KeyframeChannelNumber' && n.params.paramPath === 'timeSpeed',
    );
    return (ch?.params.keyframes as { time: number; value: number }[] | undefined)?.map((k) => [
      k.time,
      k.value,
    ]);
  });
  expect(keys).toEqual([
    [1, 1],
    [1.5, 0.05],
  ]);

  // After the ramp the scene crawls: from 2 s to 3 s of playhead it moves 0.05 s.
  const a = await drawnAt(page, 2);
  const b = await drawnAt(page, 3);
  expect(b.scene - a.scene).toBeCloseTo(0.05, 3);
  expect(b.box - a.box).toBeCloseTo(0.1, 2);
  expect(b.camera - a.camera).toBeCloseTo(2, 2);
});

const keyTimes = (page: import('@playwright/test').Page, find: string) =>
  page.evaluate((f) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const [type, key, value] = f.split('|');
    const ch = Object.entries(nodes).find(
      ([id, n]) => n.type === type && (key === 'id' ? id === value : n.params[key] === value),
    )?.[1];
    return (ch?.params.keyframes as { time: number }[] | undefined)?.map((k) => k.time);
  }, find);

test('in a slowed scene, a speed key and a camera key land on the playhead, not on scene time', async ({
  page,
}) => {
  await boot(page);
  // Half speed from the start: at the 2 s playhead the scene is at 1 s.
  await page.getByTestId('timebar-speed').fill('0.5');
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0));
  await page.getByTestId('timebar-speed-diamond').click();
  const at2 = await drawnAt(page, 2);
  expect(at2.scene).toBeCloseTo(1, 6);
  await page.getByTestId('timebar-speed-diamond').click();
  // The speed is read on the playhead's clock, so it is keyed there: 0 and 2, not 0 and 1.
  expect(await keyTimes(page, 'KeyframeChannelNumber|paramPath|timeSpeed')).toEqual([0, 2]);

  // The camera's position diamond in the inspector keys at the playhead too: 0, 2, 4 — a key
  // at 1 (scene time) would play back at the wrong moment.
  await page.evaluate(() => {
    const w = window as unknown as W & {
      __basher_selection: { getState: () => { select: (id: string) => void } };
    };
    w.__basher_selection.getState().select('n_camera');
  });
  await page.getByTestId('inspector-diamond-n_camera-position').click();
  expect(await keyTimes(page, 'KeyframeChannelVec3|id|p1594_cam')).toEqual([0, 2, 4]);

  // A box key at the same playhead lands at scene time.
  await page.evaluate(() => {
    const w = window as unknown as W & {
      __basher_selection: { getState: () => { select: (id: string) => void } };
    };
    w.__basher_selection.getState().select('n_box');
  });
  await page.getByTestId('inspector-diamond-n_box-position').click();
  expect(await keyTimes(page, 'KeyframeChannelVec3|id|p1594_box')).toEqual([0, 1, 4]);
});

test("the Curve Editor's playhead follows each curve's own clock", async ({ page }) => {
  await boot(page);
  // A keyed quarter speed, so the Scene has a curve to show.
  await page.evaluate(() => {
    const w = window as unknown as W & {
      __basher_viewport: {
        getState: () => { setTimelineDrawerOpen: (o: boolean) => void };
      };
      __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
    };
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1594_speed',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'timeSpeed',
            target: 'n_scene',
            paramPath: 'timeSpeed',
            keyframes: [
              { time: 0, value: 0.25, easing: 'linear' },
              { time: 4, value: 0.25, easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p1594-speed',
    );
    w.__basher_viewport.getState().setTimelineDrawerOpen(true);
    w.__basher_timeline_dock.getState().setActiveTab('curve');
  });
  const playheadX = async (subject: string, film: number) => {
    await page.evaluate(
      ({ id, t }) => {
        const w = window as unknown as W & {
          __basher_selection: { getState: () => { select: (id: string) => void } };
        };
        w.__basher_selection.getState().select(id);
        w.__basher_time.getState().setTime(t);
      },
      { id: subject, t: film },
    );
    await page.waitForTimeout(150);
    return Number(await page.getByTestId('curve-playhead').getAttribute('x1'));
  };
  // The speed's curve is on the playhead's clock: at the 2 s playhead its line is at 2 s.
  const speedAt2 = await playheadX('n_scene', 2);
  // The box's curve is on scene time: at the 2 s playhead the scene is at 0.5 s; at 8 s, at 2 s.
  const boxAt2 = await playheadX('n_box', 2);
  const boxAt8 = await playheadX('n_box', 8);
  expect(boxAt2).toBeLessThan(speedAt2 - 1);
  expect(boxAt8).toBeCloseTo(speedAt2, 1);
});
