// #1778 — with camera cuts, looking through the camera shows each shot in the projection of the
// camera live at the playhead. Before, the look-through picked perspective or orthographic once,
// from the camera active with no playhead, and kept it across every cut: an orthographic shot
// after a perspective one was shown in perspective, and the other way round.
//
// Observed on the view camera the viewport draws through (`__basher_view_camera`): its projection,
// and on the orthographic side the frame its Orthographic Scale sets.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraOps } from './_splitCamera';

type Ref = { node: string; socket: string };
interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: { nodes: Record<string, { type: string; inputs: Record<string, unknown> }> };
    };
  };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_setActiveCamera: (id: string) => boolean;
  __basher_dispatchMutator: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: boolean; reason?: string };
  __basher_view_camera: () => {
    isOrthographic: boolean;
    position: [number, number, number];
    orthoFrame: { height: number } | null;
  } | null;
}

const ORTHO = 'p1778_ortho';
const ORTHO_SCALE = 4;

/** The default (perspective) camera plus an orthographic one at X 20, a cut channel on the
 *  camera switch keying `first` at 0 s and `second` at 2 s, look-through on, paused at 0 s. */
async function boot(page: Page, first: string, second: string) {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(
      w.__basher_dag &&
      w.__basher_setActiveCamera &&
      w.__basher_dispatchMutator &&
      w.__basher_view_camera,
    );
  });
  const keyed = await page.evaluate(
    ({ ops, first, second }) => {
      const w = window as unknown as W;
      for (const op of ops) w.__basher_dag.getState().dispatch(op);
      // Make each active once, so both are in the camera switch's list; end on `first`.
      w.__basher_setActiveCamera(second);
      w.__basher_setActiveCamera(first);
      const st = w.__basher_dag.getState().state;
      const sel = Object.entries(st.nodes).find(([, n]) => n.type === 'CameraSelect');
      if (!sel) return { ok: false, reason: 'no camera switch' };
      if (!(sel[1].inputs.cameras as Ref[]).some((r) => r.node === second))
        return { ok: false, reason: 'second camera not listed' };
      const add = w.__basher_dispatchMutator(
        'mutator.timeline.addChannel',
        {
          target: sel[0],
          paramPath: 'active',
          valueType: 'text',
          channelId: 'p1778_cuts',
          initialKeyframe: { time: 0, value: first },
        },
        'cut',
      );
      if (!add.ok) return add;
      const cut = w.__basher_dispatchMutator(
        'mutator.timeline.keyframe',
        { channelId: 'p1778_cuts', time: 2, value: second },
        'cut at 2',
      );
      if (!cut.ok) return cut;
      w.__basher_time.getState().pause();
      w.__basher_time.getState().setTime(0);
      w.__basher_viewport.getState().setLookThroughCamera(true);
      return { ok: true };
    },
    {
      ops: splitCameraOps({
        objectId: ORTHO,
        position: [20, 2, 8],
        lookAt: [20, 0, 0],
        lens: { projection: 'Orthographic', orthoScale: ORTHO_SCALE },
      }),
      first,
      second,
    },
  );
  expect(keyed.ok, keyed.reason).toBe(true);
}

/** What the viewport draws through at playhead `s`. */
async function viewAt(page: Page, s: number) {
  await page.evaluate((sec) => (window as unknown as W).__basher_time.getState().setTime(sec), s);
  // The projection swap re-mounts the view camera, so poll rather than read once.
  return () =>
    page.evaluate(() => (window as unknown as Partial<W>).__basher_view_camera?.() ?? null);
}

test('perspective shot, then a cut to an orthographic one: the second is shown orthographic', async ({
  page,
}) => {
  await boot(page, 'n_camera', ORTHO);
  let read = await viewAt(page, 1);
  await expect.poll(async () => (await read())?.isOrthographic).toBe(false);
  read = await viewAt(page, 3);
  await expect.poll(async () => (await read())?.isOrthographic).toBe(true);
  // Through the orthographic camera, framed by its own scale.
  await expect.poll(async () => Math.round((await read())!.position[0])).toBe(20);
  await expect.poll(async () => (await read())?.orthoFrame?.height).toBeCloseTo(ORTHO_SCALE, 3);
  // And back across the cut.
  read = await viewAt(page, 1);
  await expect.poll(async () => (await read())?.isOrthographic).toBe(false);
});

test('orthographic shot, then a cut to a perspective one: the second is shown in perspective', async ({
  page,
}) => {
  await boot(page, ORTHO, 'n_camera');
  let read = await viewAt(page, 1);
  await expect.poll(async () => (await read())?.isOrthographic).toBe(true);
  await expect.poll(async () => (await read())?.orthoFrame?.height).toBeCloseTo(ORTHO_SCALE, 3);
  read = await viewAt(page, 3);
  await expect.poll(async () => (await read())?.isOrthographic).toBe(false);
  await expect.poll(async () => Math.round((await read())!.position[0])).toBe(3);
});
