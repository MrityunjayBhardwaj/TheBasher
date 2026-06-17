// P6 W6 acceptance — animate-mode keyboard shortcuts + bottom toolbar +
// SimplifyPopover (UI-SPEC §5.9 + §6.2 + D-W6-1..5).
//
// Coverage:
//   #1 bottom toolbar visible in Animate mode with drawer open; buttons
//      disabled until a channel / keyframe is selected
//   #2 K (keyboard) inserts a keyframe at the current frame into the
//      active channel
//   #3 Key button (toolbar) mirrors K
//   #4 clicking a Dopesheet diamond sets activeKeyframeId; Delete key
//      removes that keyframe; Delete button is disabled when no
//      keyframe is selected (D-W6-2)
//   #5 [ / ] seek to previous / next keyframe time on the active channel
//   #6 Clear button (toolbar) empties the active channel's keyframes
//   #7 Simplify popover opens, validates tolerance input, dispatches
//      mutator.timeline.simplifyChannel via the five-gate validator
//      (D-W6-4)
//
// REF: docs/UI-SPEC.md §5.9 bottom toolbar + §6.2 keyboard model;
// D-W6-1..5 (memory/project_p6_w6_context.md).

import { expect, test } from './_fixtures';

interface KeyframeShape {
  time: number;
  value: unknown;
  easing: 'linear' | 'cubic';
}

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            type: string;
            params?: { keyframes?: KeyframeShape[] } & Record<string, unknown>;
          }
        >;
      };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_viewport?: { getState: () => { timelineDrawerOpen: boolean } };
  __basher_time?: { getState: () => { setTime: (s: number) => void; seconds: number } };
  // P6 W9: TimelineCanvas paints channel rows + keyframe diamonds onto a
  // 2D <canvas> (no per-row/per-diamond DOM, D-W9-4 forbids pixel-
  // clicking). Channel + keyframe selection — exactly what the SVG
  // row/diamond onClick handlers did (setActiveChannel /
  // setActiveKeyframe) — routes through this store seam.
  __basher_timeline_selection?: {
    getState: () => {
      setActiveChannel: (id: string | null) => void;
      setActiveKeyframe: (ref: { channelId: string; time: number } | null) => void;
      activeKeyframeId: { channelId: string; time: number } | null;
    };
  };
}

/** P6 W9 — select a channel via the timelineSelection seam (replaces a
 *  `channel-row-{id}` DOM click; the SVG row's onClick called exactly
 *  this). */
async function selectChannel(
  page: import('@playwright/test').Page,
  channelId: string,
): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    w.__basher_timeline_selection!.getState().setActiveChannel(id);
  }, channelId);
}

/** P6 W9 — select a keyframe via the seam (replaces a
 *  `keyframe-diamond-{ch}-{i}` click; the SVG diamond's onClick set the
 *  active channel AND the (channelId,time) keyframe ref — mirror both). */
async function selectKeyframe(
  page: import('@playwright/test').Page,
  channelId: string,
  time: number,
): Promise<void> {
  await page.evaluate(
    ({ channelId, time }) => {
      const w = window as unknown as BasherWindow;
      const sel = w.__basher_timeline_selection!.getState();
      sel.setActiveChannel(channelId);
      sel.setActiveKeyframe({ channelId, time });
    },
    { channelId, time },
  );
}

test.beforeEach(async ({ page }) => {
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
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('basher.timelineDock.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_dag && w.__basher_viewport && w.__basher_time && w.__basher_timeline_selection,
    );
  });
  // Seed a free-floating Number channel (V57) with 3 keyframes so all W6
  // features have something to operate on — no AnimationLayer wrapper, the
  // channel targets the DirectionalLight directly by dagId. Channel targets a
  // DirectionalLight's `intensity` param — DirectionalLight has intensity as a
  // native number in its paramSchema, so K-insert can read it back at press
  // time without tripping setParam schema validation (BoxMesh has no
  // intensity field; targeting box.intensity would fail silently).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    if (!Object.values(dag.state.nodes).some((n) => n.type === 'TimeSource')) {
      dag.dispatch({ type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} });
    }
    const timeId =
      Object.entries(dag.state.nodes).find(([, n]) => n.type === 'TimeSource')?.[0] ?? 'time';
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'sun',
          nodeType: 'DirectionalLight',
          params: {
            intensity: 7,
            position: [5, 5, 5],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            color: '#ffffff',
          },
        },
        {
          type: 'addNode',
          nodeId: 'ch',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'intensity',
            target: 'sun',
            paramPath: 'intensity',
            keyframes: [
              { time: 0, value: 0, easing: 'linear' },
              { time: 0.5, value: 5, easing: 'linear' },
              { time: 1, value: 10, easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'seed',
    );
  });
  await page.getByTestId('floating-toolbar-timeline').click();
});

async function readChannelKeyframes(
  page: import('@playwright/test').Page,
): Promise<KeyframeShape[]> {
  return await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const ch = w.__basher_dag!.getState().state.nodes['ch'];
    return (ch.params?.keyframes ?? []) as KeyframeShape[];
  });
}

test('P6.W6#1 bottom toolbar visible with disabled buttons until selection', async ({ page }) => {
  await expect(page.getByTestId('timeline-dock-toolbar')).toBeVisible();
  // No active channel yet — Key/Simplify/Clear disabled.
  await expect(page.getByTestId('timeline-toolbar-key')).toHaveAttribute('data-disabled', 'true');
  await expect(page.getByTestId('timeline-toolbar-simplify')).toHaveAttribute(
    'data-disabled',
    'true',
  );
  await expect(page.getByTestId('timeline-toolbar-clear')).toHaveAttribute('data-disabled', 'true');
  // Delete disabled regardless of channel — needs an active keyframe.
  await expect(page.getByTestId('timeline-toolbar-delete')).toHaveAttribute(
    'data-disabled',
    'true',
  );
  // Click channel row → Key/Simplify/Clear enable; Delete still disabled.
  await selectChannel(page, 'ch');
  await expect(page.getByTestId('timeline-toolbar-key')).toHaveAttribute('data-disabled', 'false');
  await expect(page.getByTestId('timeline-toolbar-simplify')).toHaveAttribute(
    'data-disabled',
    'false',
  );
  await expect(page.getByTestId('timeline-toolbar-clear')).toHaveAttribute(
    'data-disabled',
    'false',
  );
  await expect(page.getByTestId('timeline-toolbar-delete')).toHaveAttribute(
    'data-disabled',
    'true',
  );
});

test('P6.W6#2 K keyboard inserts a keyframe at current time on active channel', async ({
  page,
}) => {
  await selectChannel(page, 'ch');
  // Move time to 0.25 (between existing keyframes).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().setTime(0.25);
  });
  await page.keyboard.press('k');
  const keyframes = await readChannelKeyframes(page);
  // Should now be 4 keyframes (was 3); new one at t=0.25 with the box's
  // intensity (7). Sort order: 0, 0.25, 0.5, 1.
  expect(keyframes).toHaveLength(4);
  expect(keyframes[1].time).toBe(0.25);
  expect(keyframes[1].value).toBe(7);
});

test('P6.W6#3 Key button mirrors K keyboard', async ({ page }) => {
  await selectChannel(page, 'ch');
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().setTime(0.75);
  });
  await page.getByTestId('timeline-toolbar-key').click();
  const keyframes = await readChannelKeyframes(page);
  expect(keyframes).toHaveLength(4);
  expect(keyframes[2].time).toBe(0.75);
  expect(keyframes[2].value).toBe(7);
});

test('P6.W6#4 click diamond selects keyframe; Delete removes it (D-W6-2)', async ({ page }) => {
  await selectChannel(page, 'ch');
  // Initially Delete is disabled.
  await expect(page.getByTestId('timeline-toolbar-delete')).toHaveAttribute(
    'data-disabled',
    'true',
  );
  // P6 W9: select the middle keyframe (seeded at time 0.5) via the
  // timelineSelection seam — the SVG diamond's onClick set exactly this
  // (channelId,time) ref; the canvas paints diamonds with no per-diamond
  // DOM. Assert selection took via the live selection store (the
  // toolbar's disabled state is downstream of activeKeyframeId, so the
  // data-disabled flip below is the real D-W6-2 observation).
  await selectKeyframe(page, 'ch', 0.5);
  const sel = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_timeline_selection!.getState().activeKeyframeId;
  });
  expect(sel).toEqual({ channelId: 'ch', time: 0.5 });
  await expect(page.getByTestId('timeline-toolbar-delete')).toHaveAttribute(
    'data-disabled',
    'false',
  );
  // Press Delete — keyframe at t=0.5 should disappear.
  await page.keyboard.press('Delete');
  const keyframes = await readChannelKeyframes(page);
  expect(keyframes).toHaveLength(2);
  expect(keyframes.map((k) => k.time)).toEqual([0, 1]);
  // After delete, Delete becomes disabled again (activeKeyframeId cleared).
  await expect(page.getByTestId('timeline-toolbar-delete')).toHaveAttribute(
    'data-disabled',
    'true',
  );
});

test('P6.W6#5 [ and ] seek to previous / next keyframe time', async ({ page }) => {
  await selectChannel(page, 'ch');
  // Start at t=0.7 (between 0.5 and 1).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().setTime(0.7);
  });
  // ] → next keyframe = 1.0
  await page.keyboard.press(']');
  const tAfterNext = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_time!.getState().seconds;
  });
  expect(tAfterNext).toBe(1);
  // [ → prev keyframe from 1 = 0.5
  await page.keyboard.press('[');
  const tAfterPrev = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_time!.getState().seconds;
  });
  expect(tAfterPrev).toBe(0.5);
});

test('P6.W6#6 Clear button empties the active channel via the Mutator', async ({ page }) => {
  await selectChannel(page, 'ch');
  await page.getByTestId('timeline-toolbar-clear').click();
  const keyframes = await readChannelKeyframes(page);
  expect(keyframes).toEqual([]);
});

test('P6.W6#7 Simplify popover applies mutator.timeline.simplifyChannel', async ({ page }) => {
  // Seed a linear ramp with 5 collinear samples — aggressive tolerance
  // should reduce to 2 endpoints.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    dag.dispatch({
      type: 'setParam',
      nodeId: 'ch',
      paramPath: 'keyframes',
      value: [
        { time: 0, value: 0, easing: 'linear' },
        { time: 0.25, value: 0.25, easing: 'linear' },
        { time: 0.5, value: 0.5, easing: 'linear' },
        { time: 0.75, value: 0.75, easing: 'linear' },
        { time: 1, value: 1, easing: 'linear' },
      ],
    });
  });
  await selectChannel(page, 'ch');
  await page.getByTestId('timeline-toolbar-simplify').click();
  await expect(page.getByTestId('simplify-popover')).toBeVisible();
  // Tolerance 0.01 — collinear interior keyframes drop.
  await page.getByTestId('simplify-popover-input').fill('0.01');
  await page.getByTestId('simplify-popover-apply').click();
  await expect(page.getByTestId('simplify-popover')).toBeHidden();
  const keyframes = await readChannelKeyframes(page);
  expect(keyframes).toHaveLength(2);
  expect(keyframes[0].time).toBe(0);
  expect(keyframes[1].time).toBe(1);
});
