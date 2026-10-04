// #1484 — a dragged key lands on the frame it was drawn at, and a click doesn't move it.
//
// Measured before the fix (2026-10-04): clicking the dope-sheet key at 1 s, with no drag, moved it
// to 1.0057 s (frame 60.34); a 40 px drag landed at 1.5805 s (frame 94.83). The ghost followed the
// cursor and the commit wrote the raw cursor time, and the only "no-op" guard was an exact
// float compare, so any pixel off the key's centre wrote. The curve editor's key drag was unrounded
// too, and a click there re-committed the unchanged keys.
//
// Each test drives the real pointer, then reads the channel's keys off the DAG. Positions come from
// the same geometry functions the dope sheet draws with.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { params: Record<string, unknown> }>;
      };
      undoStack: unknown[];
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_viewport: { getState: () => { setTimelineDrawerOpen: (v: boolean) => void } };
  __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_timeline_selection: {
    getState: () => { setActiveChannel: (id: string | null) => void };
  };
}

const CH = 'n_p1484_x';
const KEYS = [
  { time: 0, value: 0, easing: 'cubic' },
  { time: 1, value: 5, easing: 'cubic' },
  { time: 2, value: 1, easing: 'cubic' },
  { time: 3, value: 0, easing: 'cubic' },
];

async function seed(page: Page, tab: 'dopesheet' | 'curve') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  await page.evaluate(
    ({ ch, keys, tab }) => {
      const w = window as unknown as W;
      const dag = w.__basher_dag.getState();
      dag.dispatchAtomic(
        [
          dag.state.nodes[ch]
            ? { type: 'setParam', nodeId: ch, paramPath: 'keyframes', value: keys }
            : {
                type: 'addNode',
                nodeId: ch,
                nodeType: 'KeyframeChannelNumber',
                params: { name: 'x', target: '', paramPath: 'intensity', keyframes: keys },
              },
        ],
        'user',
        'seed',
      );
      w.__basher_viewport.getState().setTimelineDrawerOpen(true);
      w.__basher_timeline_dock.getState().setActiveTab(tab);
      w.__basher_timeline_selection.getState().setActiveChannel(ch);
    },
    { ch: CH, keys: KEYS, tab },
  );
}

const times = (page: Page) =>
  page.evaluate(
    (ch) =>
      (
        (window as unknown as W).__basher_dag.getState().state.nodes[ch].params.keyframes as {
          time: number;
        }[]
      ).map((k) => k.time),
    CH,
  );
const undoDepth = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_dag.getState().undoStack.length);

/** Page coordinates of the dope-sheet key at `seconds` on the channel's row. */
async function dopeKey(page: Page, seconds: number) {
  const canvas = page.getByTestId('timeline-canvas').locator('canvas');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const rows = await page.evaluate(async () => {
    const tc = await import('/src/timeline/TimelineCanvas.tsx');
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes as never;
    return tc.collectChannelRows(nodes).map((r: { channelId: string }) => r.channelId);
  });
  const row = rows.indexOf(CH);
  expect(row, 'the seeded channel has a dope-sheet row').toBeGreaterThanOrEqual(0);
  const x = await page.evaluate(
    async ({ seconds, width }) => {
      const v = await import('/src/timeline/timelineView.ts');
      const s = await import('/src/timeline/timelineSettings.ts');
      const store = await import('/src/timeline/timelineViewStore.ts');
      const gutter = s.DOPESHEET_GUTTER_WIDTH_PX;
      return v.frameToX(
        seconds * 60,
        600,
        store.useTimelineViewStore.getState().view,
        gutter,
        width - gutter,
        s.DOPESHEET_DIAMOND_INSET_PX,
      );
    },
    { seconds, width: box.width },
  );
  // Ruler 17 px, rows 24 px (timelineSettings.json); the middle of the row.
  return { x: box.x + x, y: box.y + 17 + row * 24 + 12 };
}

test.describe('#1484 — the dope sheet', () => {
  test('a click on a key, off its centre, selects it and writes nothing', async ({ page }) => {
    await seed(page, 'dopesheet');
    const k = await dopeKey(page, 1);
    const depth = await undoDepth(page);
    await page.mouse.click(k.x + 2, k.y);
    await page.waitForTimeout(150);
    expect(await times(page)).toEqual([0, 1, 2, 3]);
    expect(await undoDepth(page)).toBe(depth);
  });

  test('a click on a key that sits between frames leaves it there', async ({ page }) => {
    await seed(page, 'dopesheet');
    // Imports and bakes put keys between frames; a click must not snap them onto one.
    await page.evaluate(
      (ch) =>
        (window as unknown as W).__basher_dag.getState().dispatchAtomic(
          [
            {
              type: 'setParam',
              nodeId: ch,
              paramPath: 'keyframes',
              value: [
                { time: 0, value: 0, easing: 'cubic' },
                { time: 1.0057, value: 5, easing: 'cubic' },
                { time: 3, value: 0, easing: 'cubic' },
              ],
            },
          ],
          'user',
          'subframe key',
        ),
      CH,
    );
    const k = await dopeKey(page, 1.0057);
    await page.mouse.click(k.x, k.y);
    await page.waitForTimeout(150);
    expect(await times(page)).toEqual([0, 1.0057, 3]);
  });

  test('a click that wobbles 2 px, under the drag threshold, writes nothing', async ({ page }) => {
    await seed(page, 'dopesheet');
    const k = await dopeKey(page, 1);
    const depth = await undoDepth(page);
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x + 2, k.y + 1);
    await page.mouse.up();
    await page.waitForTimeout(150);
    expect(await times(page)).toEqual([0, 1, 2, 3]);
    expect(await undoDepth(page)).toBe(depth);
  });

  test('a drag lands on a whole frame', async ({ page }) => {
    await seed(page, 'dopesheet');
    const k = await dopeKey(page, 1);
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x + 40, k.y, { steps: 8 });
    await page.mouse.up();
    const moved = (await times(page))[1];
    expect(moved).toBeGreaterThan(1);
    expect(moved * 60, `landed at frame ${moved * 60}`).toBe(Math.round(moved * 60));
  });

  test('a drag with Ctrl held lands between frames', async ({ page }) => {
    await seed(page, 'dopesheet');
    const k = await dopeKey(page, 1);
    await page.mouse.move(k.x, k.y);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(k.x + 40, k.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    const moved = (await times(page))[1];
    expect(moved).toBeGreaterThan(1);
    expect(moved * 60).not.toBe(Math.round(moved * 60));
  });
});

test.describe('#1484 — the curve editor', () => {
  test('a click on a key writes nothing, not even an undo entry', async ({ page }) => {
    await seed(page, 'curve');
    const dot = page.locator('[data-testid="curve-key-1-0"]');
    await expect(dot).toBeVisible();
    const b = (await dot.boundingBox())!;
    const depth = await undoDepth(page);
    await page.mouse.click(b.x + b.width / 2 + 1, b.y + b.height / 2 + 1);
    await page.waitForTimeout(150);
    expect(await times(page)).toEqual([0, 1, 2, 3]);
    expect(await undoDepth(page)).toBe(depth);
  });

  test('a click that wobbles 2 px, under the drag threshold, moves nothing', async ({ page }) => {
    await seed(page, 'curve');
    const dot = page.locator('[data-testid="curve-key-1-0"]');
    await expect(dot).toBeVisible();
    const b = (await dot.boundingBox())!;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const before = await page.evaluate(
      (ch) =>
        JSON.stringify((window as unknown as W).__basher_dag.getState().state.nodes[ch].params),
      CH,
    );
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 1, cy - 2);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await page.evaluate(
      (ch) =>
        JSON.stringify((window as unknown as W).__basher_dag.getState().state.nodes[ch].params),
      CH,
    );
    expect(after).toBe(before);
  });

  test('a key drag lands on a whole frame', async ({ page }) => {
    await seed(page, 'curve');
    const dot = page.locator('[data-testid="curve-key-1-0"]');
    await expect(dot).toBeVisible();
    const b = (await dot.boundingBox())!;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 23, cy - 10, { steps: 8 });
    await page.mouse.up();
    const moved = (await times(page))[1];
    expect(moved).toBeGreaterThan(1);
    expect(moved * 60, `landed at frame ${moved * 60}`).toBe(Math.round(moved * 60));
  });
});
