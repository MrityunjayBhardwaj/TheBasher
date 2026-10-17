// p1595 (#1595) — the Shots tab lists the film's shots, read off the camera cuts; each edit is one
// undo step; and dragging a cut on the timeline moves where the film cuts, in the viewport and in a
// render.
//
// Three cameras told apart by X (the seed camera, 20, 40). Read what is DRAWN — the camera the
// viewport looks through (`__basher_view_camera`) and the rendered PNG — never the rows' own data.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraOps } from './_splitCamera';

// A render and dozens of page round trips: more than the default 30 s on a loaded machine.
test.setTimeout(180_000);

interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      undo: () => void;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_time: {
    getState: () => { setTime: (s: number) => void; filmSeconds: number; durationSeconds: number };
  };
  __basher_viewport: {
    getState: () => { lookThroughCamera: boolean; setTimelineDrawerOpen: (on: boolean) => void };
  };
  __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_view_camera: () => { position: [number, number, number] } | null;
  __basher_render_png: () => Promise<{ dataUrl: string } | null>;
}

const CAM2 = 'p1595_cam2';
const CAM3 = 'p1595_cam3';
// Geometry mirrors TimelineCanvas.tsx (as p7.1 does): an 84 px label gutter, 10 px diamonds,
// a 17 px ruler above the rows.
const LABEL_GUTTER = 84;
const DIAMOND = 10;
const INSET = 4;
const RULER_H = 17;
function diamondCx(t: number, span: number, canvasW: number): number {
  const trackWidth = Math.max(canvasW - LABEL_GUTTER, 0);
  const inset = Math.max(INSET, DIAMOND / 2);
  const innerW = trackWidth - 2 * inset;
  return LABEL_GUTTER + inset + (Math.min(Math.max(t, 0), span) / span) * innerW;
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
    localStorage.removeItem('basher.timelineDock.v1');
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag && w.__basher_time && w.__basher_view_camera && w.__basher_render_png,
    );
  });
  await page.evaluate(
    (ops) => {
      for (const op of ops) (window as unknown as W).__basher_dag.getState().dispatch(op);
    },
    [
      ...splitCameraOps({ objectId: CAM2, position: [20, 2, 8], lookAt: [20, 0, 0] }),
      ...splitCameraOps({ objectId: CAM3, position: [40, 2, 8], lookAt: [40, 0, 0] }),
    ],
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

const setPlayhead = (page: Page, s: number) =>
  page.evaluate((sec) => (window as unknown as W).__basher_time.getState().setTime(sec), s);

const renderAt = (page: Page, s: number) =>
  page.evaluate(async (sec) => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(sec);
    return (await w.__basher_render_png())!.dataUrl;
  }, s);

const rows = (page: Page) => page.locator('[data-testid^="shot-row-"]');

test('shots are listed from the cuts, edited one undo at a time, and a dragged cut moves the film', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('left-sidebar-tab-shots').click();
  await expect(page.getByTestId('shots-panel')).toBeVisible();
  // One camera wired, nothing cut: one shot over the whole film.
  await expect(rows(page)).toHaveCount(1);

  // Two cuts from the panel: at 2 s to the third camera, at 4 s to the second.
  await setPlayhead(page, 2);
  await page.getByTestId('shots-cut-camera').selectOption(CAM3);
  await page.getByTestId('shots-cut-here').click();
  await expect(rows(page)).toHaveCount(2);
  await setPlayhead(page, 4);
  await page.getByTestId('shots-cut-camera').selectOption(CAM2);
  await page.getByTestId('shots-cut-here').click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByTestId('shot-row-1')).toContainText('2.00 s – 4.00 s');
  await expect(page.getByTestId('shot-camera-1')).toHaveValue(CAM3);
  await expect(page.getByTestId('shot-camera-2')).toHaveValue(CAM2);

  // Selecting a shot looks through its camera at its first frame.
  await page.getByTestId('shot-select-1').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_time.getState().filmSeconds))
    .toBe(2);
  expect(
    await page.evaluate(
      () => (window as unknown as W).__basher_viewport.getState().lookThroughCamera,
    ),
  ).toBe(true);
  const seedX = await drawnAt(page, 1);
  expect(await drawnAt(page, 2)).toBe(40);
  expect(await drawnAt(page, 4.5)).toBe(20);

  // Changing the third shot's camera is one undo step.
  await page.getByTestId('shot-camera-2').selectOption('n_camera');
  expect(await drawnAt(page, 4.5)).toBe(seedX);
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect(await drawnAt(page, 4.5)).toBe(20);

  // Removing the cut at 4 s lets the second shot run on; one undo puts it back.
  await page.getByTestId('shot-remove-2').click();
  await expect(rows(page)).toHaveCount(2);
  expect(await drawnAt(page, 4.5)).toBe(40);
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect(rows(page)).toHaveCount(3);

  // Renders on either side of the cut at 2 s, before it moves.
  const seedRender = await renderAt(page, 1);
  const thirdRender = await renderAt(page, 3);
  expect(seedRender, 'the two cameras render differently').not.toBe(thirdRender);
  expect(await renderAt(page, 1.98)).toBe(seedRender);

  // Drag the cut at 2 s two frames earlier on the dopesheet's cuts row.
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_viewport.getState().setTimelineDrawerOpen(true);
    w.__basher_timeline_dock.getState().setActiveTab('dopesheet');
  });
  const canvas = page.getByTestId('timeline-canvas').locator('canvas');
  await expect(canvas).toBeVisible();
  const span = await page.evaluate(
    () => (window as unknown as W).__basher_time.getState().durationSeconds,
  );
  const box = (await canvas.boundingBox())!;
  const y = box.y + RULER_H + 12;
  const fromX = box.x + diamondCx(2, span, box.width);
  const toX = box.x + diamondCx(2 - 2 / 60, span, box.width);
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  // Two frames is under 2 px at this zoom, below the 3 px drag threshold (a click selects the
  // key); pass the threshold first and come back, as a hand does.
  await page.mouse.move(fromX - 12, y);
  await page.waitForTimeout(25);
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(fromX - 12 + (toX - fromX + 12) * (i / 8), y);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await expect(page.getByTestId('shot-row-1')).toContainText('1.97 s – 4.00 s');

  // The film now cuts two frames earlier: in the viewport, and in a render.
  expect(await drawnAt(page, 1.95)).toBe(seedX);
  expect(await drawnAt(page, 1.98)).toBe(40);
  expect(await renderAt(page, 1.98), 'the render cuts where the viewport does').toBe(thirdRender);
  await page.getByTestId('left-sidebar-tab-shots').click();
  await page.screenshot({ path: 'test-results/p1595-shots-panel.png' });
});
