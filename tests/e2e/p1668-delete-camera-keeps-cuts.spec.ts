// p1668 (#1668) — deleting a camera leaves every shot that did not use it on its own camera.
//
// Five cameras told apart by X (seed 3, then 20, 40, 60, 80), all aimed at the default cube so
// each renders a different picture of it, cut at 2, 4, 6 and 8 s through the
// agent's doors. The switch lists them in the order they were made; the shots use them out of
// that order. Then the camera in the MIDDLE of the list is deleted with the keyboard (Delete), the
// way a director does it. Before #1668 a cut named its camera by position in that list, so every
// later camera moved up a place and the shots after it silently changed camera.
//
// Read what the viewport DRAWS THROUGH (`__basher_view_camera`) and what the RENDER frames
// (`__basher_render_png`), never the graph. One undo brings the camera and its cut back.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraOps } from './_splitCamera';

// Several sampled frames and four renders, each a page round trip.
test.setTimeout(180_000);

type Ref = { node: string; socket: string };
interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: {
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
        >;
      };
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_setActiveCamera: (id: string) => boolean;
  __basher_dispatchMutator: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: boolean; reason?: string };
  __basher_view_camera: () => { position: [number, number, number] } | null;
  __basher_render_png: () => Promise<{ dataUrl: string } | null>;
}

const CAMS = ['p1668_cam2', 'p1668_cam3', 'p1668_cam4', 'p1668_cam5'];
const [CAM2, CAM3, CAM4, CAM5] = CAMS;

async function boot(page: Page): Promise<{ sel: string; order: string[] }> {
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
      w.__basher_view_camera &&
      w.__basher_render_png &&
      w.__basher_selection,
    );
  });
  return page.evaluate(
    ({ ops, cams }) => {
      const w = window as unknown as W;
      for (const op of ops) w.__basher_dag.getState().dispatch(op);
      // Make each camera active once so every one is in the switch's list, then the seed again.
      for (const id of [...cams, 'n_camera']) w.__basher_setActiveCamera(id);
      const st = w.__basher_dag.getState().state;
      const sel = Object.entries(st.nodes).find(([, n]) => n.type === 'CameraSelect')!;
      w.__basher_viewport.getState().setLookThroughCamera(true);
      return { sel: sel[0], order: (sel[1].inputs.cameras as Ref[]).map((r) => r.node) };
    },
    {
      ops: CAMS.flatMap((id, i) =>
        splitCameraOps({
          objectId: id,
          position: [20 * (i + 1), 2, 8],
          lookAt: [0, 0.5, 0],
        }),
      ),
      cams: CAMS,
    },
  );
}

/** The X of the camera the viewport draws through at each of `secs` — one round trip each. */
async function drawnAt(page: Page, secs: number[]): Promise<number[]> {
  const out: number[] = [];
  for (const s of secs) {
    out.push(
      await page.evaluate(async (sec) => {
        const w = window as unknown as W;
        w.__basher_time.getState().setTime(sec);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
        return Math.round(w.__basher_view_camera()!.position[0]);
      }, s),
    );
  }
  return out;
}

const renderAt = (page: Page, s: number) =>
  page.evaluate(async (sec) => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(sec);
    return (await w.__basher_render_png())!.dataUrl;
  }, s);

const setPlayhead = (page: Page, s: number) =>
  page.evaluate((sec) => (window as unknown as W).__basher_time.getState().setTime(sec), s);

/** Mid-shot sample times: one inside each of the five shots. */
const MID = [1, 3, 5, 7, 9];

test('deleting the camera in the middle of the list moves no other shot, and one undo restores its cut', async ({
  page,
}) => {
  const { sel, order } = await boot(page);
  expect(order, 'the switch lists the cameras in the order they were made').toEqual([
    'n_camera',
    ...CAMS,
  ]);
  const seedX = (await drawnAt(page, [0]))[0];

  // The cuts, through the agent's doors: a text channel on `active`, each key naming its camera.
  const cuts: [number, string][] = [
    [2, CAM3],
    [4, CAM5],
    [6, CAM2],
    [8, CAM4],
  ];
  const keyed = await page.evaluate(
    ({ sel, cuts }) => {
      const w = window as unknown as W;
      const add = w.__basher_dispatchMutator(
        'mutator.timeline.addChannel',
        {
          target: sel,
          paramPath: 'active',
          valueType: 'text',
          channelId: 'p1668_cuts',
          initialKeyframe: { time: 0, value: 'n_camera' },
        },
        'cut',
      );
      if (!add.ok) return add;
      for (const [time, value] of cuts) {
        const r = w.__basher_dispatchMutator(
          'mutator.timeline.keyframe',
          { channelId: 'p1668_cuts', time, value },
          `cut at ${time}`,
        );
        if (!r.ok) return r;
      }
      return { ok: true };
    },
    { sel, cuts },
  );
  expect(keyed.ok, keyed.reason).toBe(true);

  await page.getByTestId('left-sidebar-tab-shots').click();
  await expect(page.locator('[data-testid^="shot-row-"]')).toHaveCount(5);
  const before = await drawnAt(page, MID);
  expect(before, 'each shot on its camera').toEqual([seedX, 40, 80, 20, 60]);
  const shot3Before = await renderAt(page, 5);
  const shot4Before = await renderAt(page, 7);
  expect(shot4Before, 'shots 3 and 4 are different cameras').not.toBe(shot3Before);

  // Delete cam2 — second in the list, the camera of shot 4 — with the keyboard.
  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection.getState().select(id),
    CAM2,
  );
  await page.keyboard.press('Delete');
  await expect
    .poll(() =>
      page.evaluate(
        (id) => id in (window as unknown as W).__basher_dag.getState().state.nodes,
        CAM2,
      ),
    )
    .toBe(false);

  // Shot 4's cut names a camera that is gone: shot 3 runs on through it. Every other shot keeps
  // its camera, though cam3..cam5 all moved up a place in the list.
  expect(await drawnAt(page, MID), 'after the delete').toEqual([seedX, 40, 80, 80, 60]);
  const shot4After = await renderAt(page, 7);
  expect(shot4After, 'the render of shot 4 is now shot 3’s camera').toBe(await renderAt(page, 5));
  await page.getByTestId('left-sidebar-tab-shots').click();
  await expect(page.locator('[data-testid^="shot-row-"]')).toHaveCount(4);
  await setPlayhead(page, 7);
  await page.screenshot({ path: 'test-results/p1668-after-delete.png' });

  // One undo: the camera and its cut are back.
  await page.keyboard.press('Control+z');
  await expect
    .poll(() =>
      page.evaluate(
        (id) => id in (window as unknown as W).__basher_dag.getState().state.nodes,
        CAM2,
      ),
    )
    .toBe(true);
  expect(await drawnAt(page, MID), 'after one undo').toEqual([seedX, 40, 80, 20, 60]);
  expect(await renderAt(page, 7), 'shot 4 renders as it did before the delete').toBe(shot4Before);
});
