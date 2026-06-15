// UX-BACKLOG #11 — reze-fidelity dopesheet interactions.
//
// THE FEATURE: the dopesheet canvas got a reze-studio frame ruler. Clicking /
// dragging in the ruler band SCRUBS time (reze's col-resize scrub) — the
// playhead follows because setTime is the timeStore chokepoint that mirrors
// currentFrameRef (the rAF-bypass the playhead reads).
//
// THE PROOF: a click at the horizontal MIDDLE of the ruler sets time to ~half
// the duration; dragging the cursor right advances it further — an OBSERVED
// timeStore delta driven by a real pointer on the canvas, never a store poke.

import { test, expect } from './_fixtures';

const RULER_H = 17; // TimelineCanvas.tsx RULER_H
const LABEL_GUTTER = 84; // TimelineCanvas.tsx LABEL_GUTTER_PX

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_viewport: { getState: () => { setTimelineDrawerOpen: (v: boolean) => void } };
  __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_time: {
    getState: () => { seconds: number; durationSeconds: number; setTime: (s: number) => void };
  };
  __basher_timeline_view: {
    getState: () => {
      setView: (v: { zoom: number; scroll: number }) => void;
      reset: () => void;
    };
  };
}

const CH = 'n_ch_ux11_dope';

async function seed(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_dag !== 'undefined',
  );
  await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    if (!dag.state.nodes[id]) {
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: id,
            nodeType: 'KeyframeChannelVec3',
            params: {
              name: 'position',
              target: '',
              paramPath: 'position',
              keyframes: [
                { time: 0, value: [0, 0, 0], easing: 'linear' },
                { time: 2, value: [4, 2, -3], easing: 'cubic' },
                { time: 4, value: [1, 5, 1], easing: 'cubic' },
              ],
            },
          },
        ],
        'user',
        'ux11 dope seed',
      );
    }
    w.__basher_viewport.getState().setTimelineDrawerOpen(true);
    w.__basher_timeline_dock.getState().setActiveTab('dopesheet');
    w.__basher_time.getState().setTime(0);
    w.__basher_timeline_view.getState().reset(); // start at fit (no prior zoom)
  }, CH);
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();
}

const seconds = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as BasherWindow).__basher_time.getState().seconds);

test.describe('UX #11 — reze dopesheet ruler scrub', () => {
  test('clicking the frame ruler scrubs time; dragging advances it', async ({ page }) => {
    await seed(page);
    const canvas = page.getByTestId('timeline-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    const duration = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_time.getState().durationSeconds,
    );

    // Click the horizontal MIDDLE of the ruler band (y inside [0, RULER_H]).
    const trackW = box.width - LABEL_GUTTER;
    const midX = box.x + LABEL_GUTTER + trackW * 0.5;
    const rulerY = box.y + RULER_H / 2;
    await page.mouse.click(midX, rulerY);
    await expect.poll(() => seconds(page)).toBeGreaterThan(duration * 0.4);
    const half = await seconds(page);
    expect(half).toBeLessThan(duration * 0.6); // ~midpoint, not the end

    // Drag from the middle to ~80% → time advances past the midpoint click.
    await page.mouse.move(midX, rulerY);
    await page.mouse.down();
    await page.mouse.move(box.x + LABEL_GUTTER + trackW * 0.8, rulerY, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => seconds(page)).toBeGreaterThan(half);
  });

  test('time zoom narrows the visible window — off-window keys cull (shared view)', async ({
    page,
  }) => {
    await seed(page);
    const host = page.getByTestId('timeline-canvas');
    const rendered = () => host.getAttribute('data-rendered-keyframes').then((v) => Number(v));
    // Default view (zoom 1) shows the whole timeline → all 3 keys (0/2/4s).
    await expect.poll(rendered).toBe(3);
    // Zoom 3× at scroll 0 → visible ≈ [0, 3.33s]; the 4s key falls off-window.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_timeline_view
        .getState()
        .setView({ zoom: 3, scroll: 0 }),
    );
    await expect.poll(rendered).toBe(2);
    // Reset restores the fit view → all keys visible again.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_timeline_view.getState().reset(),
    );
    await expect.poll(rendered).toBe(3);
  });
});
