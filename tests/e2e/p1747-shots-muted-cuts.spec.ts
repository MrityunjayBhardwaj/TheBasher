// p1747 (#1747) — a muted cuts channel plays one camera, and the Shots panel says so. The viewport
// already obeys the mute (the cut channel folds by the rules every channel follows); the panel
// used to list a row per key regardless, every row naming the one camera that plays, and its
// pickers wrote keys that changed nothing on screen. Read what is DRAWN (`__basher_view_camera`),
// as p1700 does, and compare the panel with it.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraOps } from './_splitCamera';

test.setTimeout(120_000);

interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      undo: () => void;
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_view_camera: () => { position: [number, number, number] } | null;
}

const CAM2 = 'p1747_cam2';
const CAM3 = 'p1747_cam3';
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
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_view_camera);
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

/** Mute (or unmute) the channel keying the camera switch's `active`: the film's cuts. */
const muteCuts = (page: Page, mute: boolean) =>
  page.evaluate((m) => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const ch = Object.values(dag.state.nodes).find(
      (n) => n.type === 'KeyframeChannelText' && n.params.paramPath === 'active',
    )!;
    dag.dispatch({ type: 'setParam', nodeId: ch.id, paramPath: 'mute', value: m });
  }, mute);

test('a muted cuts channel is one shot on the camera that plays, and the panel says so', async ({
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
  await expect(page.getByTestId('shots-cuts-muted')).toHaveCount(0);
  await page.getByTestId('shot-select-0').click(); // look through the film's camera
  expect(await drawnAt(page, 3)).toBe(40);

  await muteCuts(page, true);
  const drawn = [await drawnAt(page, 1), await drawnAt(page, 3), await drawnAt(page, 4.5)];
  const shown = {
    rows: await rows(page).count(),
    cameras: await page
      .locator('[data-testid^="shot-camera-"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value)),
  };
  console.log(`p1747 muted: drawn x ${JSON.stringify(drawn)} panel ${JSON.stringify(shown)}`);
  // The viewport plays one camera across the film (the mute is obeyed on screen)…
  expect(new Set(drawn).size, 'one camera plays the whole film').toBe(1);
  // …and the panel shows that: one shot, the whole film, on that camera.
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('shot-row-0')).toContainText('0.00 s –');
  await expect(page.getByTestId('shots-cuts-muted')).toBeVisible();
  // Writing a cut, or a shot's camera, keys a channel that is muted: nothing on screen would
  // change, so the panel does not offer it.
  await expect(page.getByTestId('shot-camera-0')).toBeDisabled();
  await expect(page.getByTestId('shots-cut-here')).toBeDisabled();

  // Unmuted, the cuts are back as they were.
  await muteCuts(page, false);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByTestId('shots-cuts-muted')).toHaveCount(0);
  expect(await drawnAt(page, 3)).toBe(40);
});
