// p1666 (#1666) — the agent's shot is the director's shot. `mutator.shot.create`, run through the
// five-gate path the model uses (`__basher_dispatchMutator`), writes the cuts the Shots tab lists,
// and the viewport and a render cut to its camera at its start and back at its end. Before #1666 it
// added a `Shot` node that nothing read, so the tab, the viewport and the render did not change.
//
// Two cameras told apart by X (the seed camera, 40). Read what is DRAWN — the camera the viewport
// looks through (`__basher_view_camera`) and the rendered PNG — as well as the tab's rows.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraOps } from './_splitCamera';

test.setTimeout(120_000);

interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      undo: () => void;
      state: { nodes: Record<string, { type: string }> };
    };
  };
  __basher_dispatchMutator?: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: true } | { ok: false; reason: string };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_viewport: { getState: () => { lookThroughCamera: boolean } };
  __basher_view_camera: () => { position: [number, number, number] } | null;
  __basher_render_png: () => Promise<{ dataUrl: string } | null>;
}

const CAM = 'p1666_cam';

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
    localStorage.removeItem('basher.timelineDock.v1');
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_view_camera &&
      w.__basher_render_png &&
      w.__basher_dispatchMutator,
    );
  });
  await page.evaluate(
    (ops) => {
      for (const op of ops) (window as unknown as W).__basher_dag.getState().dispatch(op);
    },
    splitCameraOps({ objectId: CAM, position: [40, 2, 8], lookAt: [40, 0, 0] }),
  );
}

/** The X of the camera the viewport draws through at playhead `s` (one round trip). */
const drawnAt = (page: Page, s: number) =>
  page.evaluate(async (sec) => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(sec);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    return Math.round(w.__basher_view_camera()!.position[0]);
  }, s);

const renderAt = (page: Page, s: number) =>
  page.evaluate(async (sec) => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(sec);
    return (await w.__basher_render_png())!.dataUrl;
  }, s);

const rows = (page: Page) => page.locator('[data-testid^="shot-row-"]');

test("the agent's shot is listed in the Shots tab and is the camera the viewport and the render use", async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('left-sidebar-tab-shots').click();
  await expect(page.getByTestId('shots-panel')).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  const seedRender = await renderAt(page, 3);

  const result = await page.evaluate(
    (cam) =>
      (window as unknown as W).__basher_dispatchMutator!(
        'mutator.shot.create',
        { cameraId: cam, startTime: 2, endTime: 4 },
        'a shot on the second camera from 2 to 4 seconds',
      ),
    CAM,
  );
  expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: true }));

  // The tab reads it: three shots, the middle one on the agent's camera.
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByTestId('shot-row-1')).toContainText('2.00 s – 4.00 s');
  await expect(page.getByTestId('shot-camera-1')).toHaveValue(CAM);
  // No node of the retired type was written.
  expect(
    await page.evaluate(() =>
      Object.values((window as unknown as W).__basher_dag.getState().state.nodes).some(
        (n) => n.type === 'Shot',
      ),
    ),
  ).toBe(false);

  // The viewport cuts to it at its start and back at its end.
  await page.getByTestId('shot-select-1').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__basher_viewport.getState().lookThroughCamera),
    )
    .toBe(true);
  const seedX = await drawnAt(page, 1);
  expect(seedX).not.toBe(40);
  expect(await drawnAt(page, 2)).toBe(40);
  expect(await drawnAt(page, 3.9)).toBe(40);
  expect(await drawnAt(page, 4)).toBe(seedX);

  // So does a render: at 3 s it is the agent's camera, not the seed camera it was before.
  const shotRender = await renderAt(page, 3);
  expect(shotRender, 'the render at 3 s changed camera').not.toBe(seedRender);
  expect(await renderAt(page, 5)).toBe(seedRender);

  // One undo takes the whole shot back.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect(rows(page)).toHaveCount(1);
  expect(await drawnAt(page, 3)).toBe(seedX);
});
