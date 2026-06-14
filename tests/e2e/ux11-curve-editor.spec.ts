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
    getState: () => { setActiveChannel: (id: string | null) => void };
  };
}

const CH = 'n_ch_ux11';

async function seed(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_dag !== 'undefined',
  );
  await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    w.__basher_dag.getState().dispatchAtomic(
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
    w.__basher_viewport.getState().setTimelineDrawerOpen(true);
    w.__basher_timeline_dock.getState().setActiveTab('curve');
    w.__basher_timeline_selection.getState().setActiveChannel(id);
  }, CH);
  await expect(page.getByTestId('curve-editor')).toBeVisible();
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
});
