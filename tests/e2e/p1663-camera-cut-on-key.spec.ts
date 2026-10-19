// p1663 (#1663) — a keyed camera switch lands ON its key, and never passes through the cameras
// between two indices.
//
// Three cameras, told apart by X (seed camera, 20, 40). The active camera is keyed to the seed at
// 0 s and to the third camera at 2 s, through the doors a director and the agent use today (the
// agent's add-channel, then K on the timeline). Read what the viewport DRAWS THROUGH
// (`__basher_view_camera`), not the graph: before #1663 the second camera (X 20) was on screen
// from about 0.5 s to 1.4 s and the cut to the third came near 1.5 s.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraOps } from './_splitCamera';

// 25 sampled frames, each a page round trip: more than the default 30 s on a loaded machine.
test.setTimeout(120_000);

type Ref = { node: string; socket: string };
type Key = { time: number; value: string; easing: string };
interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
      state: {
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
        >;
      };
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_viewport: {
    getState: () => {
      setLookThroughCamera: (on: boolean) => void;
      setTimelineDrawerOpen: (on: boolean) => void;
    };
  };
  __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_timeline_selection: {
    getState: () => {
      setActiveChannel: (id: string | null) => void;
      setActiveKeyframe: (ref: { channelId: string; time: number } | null) => void;
    };
  };
  __basher_setActiveCamera: (id: string) => boolean;
  __basher_dispatchMutator: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: boolean; reason?: string };
  __basher_view_camera: () => { position: [number, number, number] } | null;
}

const CAM2 = 'p1663_cam2';
const CAM3 = 'p1663_cam3';

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
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_setActiveCamera &&
      w.__basher_dispatchMutator &&
      w.__basher_view_camera,
    );
  });
  // Two more cameras, then make each active once so all three are in the CameraSelect's list.
  return page.evaluate(
    ({ ops, cams }) => {
      const w = window as unknown as W;
      for (const op of ops) w.__basher_dag.getState().dispatch(op);
      for (const id of cams) w.__basher_setActiveCamera(id);
      const st = w.__basher_dag.getState().state;
      const sel = Object.entries(st.nodes).find(([, n]) => n.type === 'CameraSelect')!;
      const order = (sel[1].inputs.cameras as Ref[]).map((r) => r.node);
      w.__basher_viewport.getState().setLookThroughCamera(true);
      return { sel: sel[0], order };
    },
    {
      ops: [
        ...splitCameraOps({ objectId: CAM2, position: [20, 2, 8], lookAt: [20, 0, 0] }),
        ...splitCameraOps({ objectId: CAM3, position: [40, 2, 8], lookAt: [40, 0, 0] }),
      ],
      cams: [CAM3, CAM2, 'n_camera'],
    },
  );
}

/** The X of the camera the viewport draws through at playhead `s` — one round trip, after two
 *  animation frames so the look-through follower has run at the new playhead. */
async function drawnCameraX(page: Page, s: number): Promise<number> {
  return page.evaluate(async (sec) => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(sec);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    return Math.round(w.__basher_view_camera()!.position[0]);
  }, s);
}

const keysOf = (page: Page, id: string) =>
  page.evaluate(
    (cid) =>
      (window as unknown as W).__basher_dag.getState().state.nodes[cid].params.keyframes as Key[],
    id,
  );

/** Every drawn camera X over 0..2 s at 24 fps. */
async function camerasOver(page: Page): Promise<number[]> {
  const xs: number[] = [];
  for (let f = 0; f <= 48; f += 2) xs.push(await drawnCameraX(page, f / 24));
  return xs;
}

test('a cut keyed by the agent and by K lands on its key and skips the camera between', async ({
  page,
}) => {
  const { sel, order } = await boot(page);
  // #1668 — a cut names its camera. The two keyed cameras still sit with one between them in the
  // switch's list, so a cut passing through positions would show it.
  expect(
    Math.abs(order.indexOf(CAM3) - order.indexOf('n_camera')),
    'a camera sits between the two keyed ones',
  ).toBe(2);
  const seedX = await drawnCameraX(page, 0);

  // Door 1 — the agent adds the channel with its first key (asking for linear).
  const add = await page.evaluate(
    ({ sel }) =>
      (window as unknown as W).__basher_dispatchMutator(
        'mutator.timeline.addChannel',
        {
          target: sel,
          paramPath: 'active',
          valueType: 'text',
          initialKeyframe: { time: 0, value: 'n_camera', easing: 'linear' },
        },
        'cut',
      ),
    { sel },
  );
  expect(add.ok, add.reason).toBe(true);
  const ch = await page.evaluate(
    (s) =>
      Object.entries((window as unknown as W).__basher_dag.getState().state.nodes).find(
        ([, n]) => n.params.target === s && n.params.paramPath === 'active',
      )?.[0],
    sel,
  );
  expect(ch, 'the channel exists').toBeTruthy();

  // Door 2 — K on the timeline at 2 s, with the active camera set to the third one.
  await page.evaluate(
    ({ sel, CAM3, ch }) => {
      const w = window as unknown as W;
      w.__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId: sel, paramPath: 'active', value: CAM3 });
      w.__basher_viewport.getState().setTimelineDrawerOpen(true);
      w.__basher_timeline_selection.getState().setActiveChannel(ch);
      w.__basher_time.getState().setTime(2);
    },
    { sel, CAM3, ch },
  );
  await page.keyboard.press('k');
  await expect.poll(async () => (await keysOf(page, ch!)).length).toBe(2);
  expect(await keysOf(page, ch!)).toEqual([
    { time: 0, value: 'n_camera', easing: 'constant' },
    { time: 2, value: CAM3, easing: 'constant' },
  ]);

  // What the viewport draws through, every other frame.
  const xs = await camerasOver(page);
  expect(
    xs.slice(0, -1).every((x) => x === seedX),
    `before the key: ${xs.join(',')}`,
  ).toBe(true);
  expect(xs.at(-1), 'on the key').toBe(40);
  expect(xs.includes(20), 'the camera between is never drawn').toBe(false);
  await page.screenshot({ path: 'test-results/p1663-on-the-key.png' });
});
