// #1485 — only the primary button drags a key, and Escape or a right-click cancels a drag.
//
// Measured before the fix (2026-10-04): a right-button drag of the dope-sheet key at 1 s moved it
// to 1.868 s; a left drag with Escape pressed before release landed at the same 1.868 s. Neither
// editor read the pointer button, and the global Escape only dismissed popovers.
//
// Each case has its control: the same drag with the left button and no cancel does move the key.

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

const CH = 'n_p1485_x';
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

/** Press on `at`, drag by `d`, and end the gesture the way `how` names. */
async function drag(
  page: Page,
  at: { x: number; y: number },
  d: { dx: number; dy: number },
  how: 'left' | 'right' | 'escape' | 'right-click',
) {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: how === 'right' ? 'right' : 'left' });
  await page.mouse.move(at.x + d.dx, at.y + d.dy, { steps: 8 });
  if (how === 'escape') await page.keyboard.press('Escape');
  if (how === 'right-click') {
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
  }
  await page.mouse.up({ button: how === 'right' ? 'right' : 'left' });
  await page.waitForTimeout(150);
}

const activeKey = (page: Page) =>
  page.evaluate(async () => {
    const m = await import('/src/timeline/timelineSelection.ts');
    return m.useTimelineSelection.getState().activeKeyframeId;
  });

const params = (page: Page) =>
  page.evaluate(
    (ch) => JSON.stringify((window as unknown as W).__basher_dag.getState().state.nodes[ch].params),
    CH,
  );

test.describe('#1485 — the dope sheet', () => {
  for (const how of ['right', 'escape', 'right-click'] as const) {
    test(`a ${how} drag leaves the key where it was`, async ({ page }) => {
      await seed(page, 'dopesheet');
      const k = await dopeKey(page, 1);
      const depth = await undoDepth(page);
      await drag(page, k, { dx: 60, dy: 0 }, how);
      expect(await times(page)).toEqual([0, 1, 2, 3]);
      expect(await undoDepth(page)).toBe(depth);
    });
  }

  test('a right-click on a key leaves the selection alone (the right button is not a select)', async ({
    page,
  }) => {
    await seed(page, 'dopesheet');
    const k = await dopeKey(page, 1);
    await page.mouse.click(k.x, k.y, { button: 'right' });
    await page.waitForTimeout(150);
    expect(await activeKey(page)).toBeNull();
  });

  test('after Escape the dope sheet looks exactly as before the drag (no ghost left)', async ({
    page,
  }) => {
    await seed(page, 'dopesheet');
    const k = await dopeKey(page, 1);
    const canvas = page.getByTestId('timeline-canvas').locator('canvas');
    // Select the key first (a press selects it), then step off the canvas for the baseline.
    await page.mouse.click(k.x, k.y);
    await page.mouse.move(k.x, k.y - 200);
    await page.waitForTimeout(300);
    const before = await canvas.screenshot();
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x + 60, k.y, { steps: 8 });
    await page.waitForTimeout(200);
    const during = await canvas.screenshot();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.mouse.move(k.x, k.y - 200);
    await page.waitForTimeout(300);
    const after = await canvas.screenshot();
    expect(during.equals(before), 'the ghost was drawn during the drag').toBe(false);
    expect(after.equals(before), 'the ghost is gone and the playhead drawn once').toBe(true);
  });

  test('control: a left drag with no cancel moves the key', async ({ page }) => {
    await seed(page, 'dopesheet');
    const k = await dopeKey(page, 1);
    await drag(page, k, { dx: 60, dy: 0 }, 'left');
    expect((await times(page))[1]).toBeGreaterThan(1);
  });
});

test.describe('#1485 — the curve editor', () => {
  async function curveKey(page: Page) {
    const dot = page.locator('[data-testid="curve-key-1-0"]');
    await expect(dot).toBeVisible();
    const b = (await dot.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  for (const how of ['right', 'escape', 'right-click'] as const) {
    test(`a ${how} drag leaves the key where it was`, async ({ page }) => {
      await seed(page, 'curve');
      const before = await params(page);
      await drag(page, await curveKey(page), { dx: 30, dy: -20 }, how);
      expect(await params(page)).toBe(before);
    });
  }

  test('a right-click on a key leaves the selection alone (the right button is not a select)', async ({
    page,
  }) => {
    await seed(page, 'curve');
    const k = await curveKey(page);
    await page.mouse.click(k.x, k.y, { button: 'right' });
    await page.waitForTimeout(150);
    expect(await activeKey(page)).toBeNull();
  });

  test('control: a left drag with no cancel moves the key', async ({ page }) => {
    await seed(page, 'curve');
    const before = await params(page);
    await drag(page, await curveKey(page), { dx: 30, dy: -20 }, 'left');
    expect(await params(page)).not.toBe(before);
  });
});
