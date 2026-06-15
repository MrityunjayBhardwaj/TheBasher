// UX-BACKLOG #11 slice 2 — the reze-style editable curve editor.
//
// THE FEATURE: the Curve Editor draws a Vec3 channel as three real cubic-bézier
// curves (x/y/z) over a value/frame grid, with draggable keyframe dots that
// write back to the channel. Curves are sampled THROUGH the shared keyframeInterp
// (the same math the renderer plays — H40), so what's drawn is what's played.
//
// THE PROOF: a seeded Vec3 channel renders 3 `curve-track-*` polylines; dragging
// a keyframe dot UP raises that component's value in the DAG (a real setParam
// write), and the keyframe count is unchanged (a move, not an insert).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: { keyframes?: { value: number[] }[] } }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_viewport: { getState: () => { setTimelineDrawerOpen: (v: boolean) => void } };
  __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_timeline_selection: {
    getState: () => {
      setActiveChannel: (id: string | null) => void;
      setActiveKeyframe: (ref: { channelId: string; time: number } | null) => void;
    };
  };
  __basher_time: { getState: () => { seconds: number; setTime: (s: number) => void } };
}

const CH = 'n_ch_ux11';

async function seed(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_dag !== 'undefined',
  );
  await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    // Idempotent: the `default` project persists in OPFS across tests, so only
    // add the channel if it isn't already present (re-adding the same id throws).
    if (!dag.state.nodes[id]) {
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: id,
            nodeType: 'KeyframeChannelVec3',
            params: {
              name: 'pos',
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
        'ux11 seed',
      );
    }
    w.__basher_viewport.getState().setTimelineDrawerOpen(true);
    w.__basher_timeline_dock.getState().setActiveTab('curve');
    w.__basher_timeline_selection.getState().setActiveChannel(id);
  }, CH);
  await expect(page.getByTestId('curve-editor')).toBeVisible();
  // Wait for the actual curve to paint (the channel resolved + EditableCurve
  // measured), not just the pane — hardens against the shared-server boot race.
  await expect(page.getByTestId('curve-track-0')).toBeAttached();
}

const keyframes = (page: import('@playwright/test').Page) =>
  page.evaluate(
    (id) =>
      (window as unknown as BasherWindow).__basher_dag.getState().state.nodes[id].params
        .keyframes ?? [],
    CH,
  );

test.describe('UX #11 — editable curve editor', () => {
  test('a Vec3 channel renders three real bézier curve tracks', async ({ page }) => {
    await seed(page);
    for (const ti of [0, 1, 2]) {
      const track = page.getByTestId(`curve-track-${ti}`);
      await expect(track).toBeAttached();
      const pts = await track.getAttribute('points');
      expect(pts && pts.trim().length, `track ${ti} drew a non-empty curve`).toBeTruthy();
    }
  });

  test('dragging a keyframe dot UP raises that value in the DAG (a real write, not an insert)', async ({
    page,
  }) => {
    await seed(page);
    // The middle keyframe (index 1), x-axis dot.
    const dot = page.getByTestId('curve-key-1-0');
    await expect(dot).toBeVisible();
    const box = (await dot.boundingBox())!;
    const before = await keyframes(page);
    const beforeX = before[1].value[0];

    // Drag the dot UP by ~50px (screen-up = larger value).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 50, { steps: 6 });
    await page.mouse.up();

    const after = await keyframes(page);
    expect(after.length, 'a drag MOVES a key, never inserts one').toBe(before.length);
    expect(after[1].value[0], 'dragging up raised the x value').toBeGreaterThan(beforeX);
    // The other components of the same key are untouched by an x-axis drag.
    expect(after[1].value[1]).toBeCloseTo(before[1].value[1], 5);
    expect(after[1].value[2]).toBeCloseTo(before[1].value[2], 5);
  });

  test('dragging a bézier OUT handle writes an explicit handle and bends the curve', async ({
    page,
  }) => {
    await seed(page);
    // Select the middle key so its handles appear.
    await page.evaluate(
      (id) =>
        (window as unknown as BasherWindow).__basher_timeline_selection
          .getState()
          .setActiveKeyframe({ channelId: id, time: 2 }),
      CH,
    );
    const handle = page.getByTestId('curve-handle-out-0');
    await expect(handle).toBeVisible();
    const trackBefore = await page.getByTestId('curve-track-0').getAttribute('points');

    const box = (await handle.boundingBox())!;
    // Drag the out-handle up + right → an explicit, non-flat handle.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 18, box.y + box.height / 2 - 30, { steps: 6 });
    await page.mouse.up();

    const after = await keyframes(page);
    const oh = (after[1] as { outHandle?: { time: number; value: number[] } }).outHandle;
    expect(oh, 'an explicit out-handle was written').toBeTruthy();
    expect(oh!.time, 'out-handle extends forward in time').toBeGreaterThan(0);
    // The curve x-track is reshaped by the handle.
    const trackAfter = await page.getByTestId('curve-track-0').getAttribute('points');
    expect(trackAfter).not.toEqual(trackBefore);
  });

  test('click/drag the frame ruler scrubs time (same gesture + chokepoint as the dopesheet)', async ({
    page,
  }) => {
    await seed(page);
    const seconds = () =>
      page.evaluate(() => (window as unknown as BasherWindow).__basher_time.getState().seconds);
    // Start at t=0 so any rightward scrub must increase time.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_time.getState().setTime(0),
    );
    expect(await seconds()).toBeCloseTo(0, 5);

    const box = (await page.getByTestId('curve-editor').boundingBox())!;
    // The ruler band is the top RULER_H(16) CSS px, right of the LABEL_W(40)
    // value gutter. Click LEFT vs RIGHT within it — time must track x.
    const rulerY = box.y + 8;
    const plotLeft = box.x + 40;
    const plotW = box.width - 40;

    await page.mouse.click(plotLeft + plotW * 0.2, rulerY);
    const tLeft = await seconds();
    await page.mouse.click(plotLeft + plotW * 0.8, rulerY);
    const tRight = await seconds();
    expect(tLeft, 'a ruler click moved time off zero').toBeGreaterThan(0);
    expect(tRight, 'clicking further right scrubs to a later time').toBeGreaterThan(tLeft);

    // A drag continuously scrubs: press near the left, drag right, time rises.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_time.getState().setTime(0),
    );
    await page.mouse.move(plotLeft + plotW * 0.1, rulerY);
    await page.mouse.down();
    await page.mouse.move(plotLeft + plotW * 0.9, rulerY, { steps: 8 });
    const tDuringDrag = await seconds();
    await page.mouse.up();
    expect(tDuringDrag, 'time advanced while dragging the ruler').toBeGreaterThan(0);
  });
});
