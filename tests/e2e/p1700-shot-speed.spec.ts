// p1700 (#1700) — speed lives on the shot. Slowing a shot in the Shots panel makes it longer, the
// cut after it moves by the time it gained, End follows, and one Undo puts all of it back; Keep
// length changes the speed and nothing else. Read what is DRAWN for the cut — the camera the
// viewport looks through (`__basher_view_camera`) — as p1595 does.
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

const CAM2 = 'p1700_cam2';
const CAM3 = 'p1700_cam3';
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

const rows = (page: Page) => page.locator('[data-testid^="shot-row-"]');

test('a shot slowed in the panel gets longer, the later cut and End follow, one undo puts it back', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('left-sidebar-tab-shots').click();
  await setPlayhead(page, 2);
  await page.getByTestId('shots-cut-camera').selectOption(CAM3);
  await page.getByTestId('shots-cut-here').click();
  await setPlayhead(page, 4);
  await page.getByTestId('shots-cut-camera').selectOption(CAM2);
  await page.getByTestId('shots-cut-here').click();
  await expect(rows(page)).toHaveCount(3);
  await page.getByTestId('shot-select-0').click();
  expect(await drawnAt(page, 3)).toBe(40);
  expect(await drawnAt(page, 4.5)).toBe(20);
  await expect(page.getByTestId('shot-speed-1')).toHaveValue('100');
  const durBefore = await page.evaluate(
    () => (window as unknown as W).__basher_time.getState().durationSeconds,
  );

  const f = page.getByTestId('shot-speed-1');
  await f.fill('50');
  await f.press('Enter');
  await expect(page.getByTestId('shot-row-1')).toContainText('2.00 s – 6.00 s');
  await expect(page.getByTestId('shot-row-2')).toContainText('6.00 s –');
  await expect(page.getByTestId('shot-speed-1')).toHaveValue('50');
  await expect(page.getByTestId('shot-speed-0')).toHaveValue('100');
  const durAfter = await page.evaluate(
    () => (window as unknown as W).__basher_time.getState().durationSeconds,
  );
  expect(durAfter - durBefore, 'the film is 2 s longer').toBeCloseTo(2, 6);
  // The slowed shot's camera holds through the time it gained; the next takes over at 6 s.
  expect(await drawnAt(page, 5.5)).toBe(40);
  expect(await drawnAt(page, 6.5)).toBe(20);

  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect(page.getByTestId('shot-row-1')).toContainText('2.00 s – 4.00 s');
  await expect(page.getByTestId('shot-speed-1')).toHaveValue('100');
  expect(await drawnAt(page, 4.5)).toBe(20);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__basher_time.getState().durationSeconds),
    )
    .toBe(durBefore);

  await page.getByTestId('shots-keep-length').check();
  await f.fill('25');
  await f.press('Enter');
  await expect(page.getByTestId('shot-speed-1')).toHaveValue('25');
  await expect(page.getByTestId('shot-row-1')).toContainText('2.00 s – 4.00 s');
  await expect(page.getByTestId('shot-row-2')).toContainText('4.00 s –');
});
