// P6 W5 acceptance — TimelineDock tab structure (UI-SPEC §5.9 + D-UX-2).
//
// Coverage:
//   #1 default active tab is Dopesheet; both panes mounted, Curve hidden
//   #2 clicking Curve Editor tab switches active pane (D-W5-1 always-mount)
//   #3 active tab persists across reload (D-W5-2)
//   #4 Frame N / total readout reflects timeStore; FPS readout shows 60
//   #5 channel-row click in Dopesheet does NOT auto-switch tab (D-W5-3)
//   #6 Curve Editor placeholder visible after explicit tab switch
//      (replaces P3#4's incidental placeholder assertion)
//
// REF: docs/UI-SPEC.md §5.9 R9 TimelineDock; §5.10 distributed status;
// D-W5-1..4 (memory/project_p6_w5_context.md); B11 W5 section-inventory.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_viewport?: { getState: () => { timelineDrawerOpen: boolean } };
  __basher_timeline_dock?: {
    getState: () => { activeTab: 'dopesheet' | 'curve' };
  };
  // P6 W9: TimelineCanvas paints channel rows onto a 2D <canvas> (no
  // per-row DOM, D-W9-4 forbids pixel-clicking), so channel selection
  // routes through this store seam instead of a `channel-row-*` click.
  __basher_timeline_selection?: {
    getState: () => {
      setActiveChannel: (id: string | null) => void;
      activeChannelId: string | null;
    };
  };
  __basher_time?: {
    getState: () => { setTime: (s: number) => void; setDuration: (s: number) => void };
  };
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
      w.__basher_dag &&
        w.__basher_viewport &&
        w.__basher_timeline_dock &&
        w.__basher_timeline_selection,
    );
  });
  // Switch into Animate so the timeline dock is visible (D-UX-1 gating).
  await page.getByTestId('mode-switcher').selectOption('animate');
});

test('P6.W5#1 drawer-open defaults to Dopesheet tab; both panes mount; Curve hidden', async ({
  page,
}) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-tab-strip')).toBeVisible();
  await expect(page.getByTestId('timeline-tab-dopesheet')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('timeline-tab-curve')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('timeline-canvas-pane')).toBeVisible();
  await expect(page.getByTestId('timeline-canvas-pane')).toHaveAttribute('data-active', 'true');
  // Curve editor in DOM (mount preservation) but hidden.
  await expect(page.getByTestId('curve-editor-pane')).toHaveCount(1);
  await expect(page.getByTestId('curve-editor-pane')).toHaveAttribute('data-active', 'false');
});

test('P6.W5#2 clicking Curve Editor tab flips visibility; both panes stay mounted', async ({
  page,
}) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  await page.getByTestId('timeline-tab-curve').click();
  await expect(page.getByTestId('timeline-tab-curve')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('timeline-tab-dopesheet')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('curve-editor-pane')).toBeVisible();
  await expect(page.getByTestId('curve-editor-pane')).toHaveAttribute('data-active', 'true');
  // Dopesheet still mounted (mount preservation invariant), just hidden.
  await expect(page.getByTestId('timeline-canvas-pane')).toHaveCount(1);
  await expect(page.getByTestId('timeline-canvas-pane')).toHaveAttribute('data-active', 'false');
});

test('P6.W5#3 active tab persists across reload (D-W5-2)', async ({ page }) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  await page.getByTestId('timeline-tab-curve').click();
  await expect(page.getByTestId('timeline-tab-curve')).toHaveAttribute('data-active', 'true');
  // localStorage should now carry activeTab=curve. Reload and verify via
  // the dev seam BEFORE opening the drawer — the persisted state lives
  // in the store regardless of whether the drawer is visible.
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_timeline_dock);
  });
  const persisted = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_timeline_dock?.getState().activeTab;
  });
  expect(persisted).toBe('curve');
  // Re-enter Animate + open drawer; Curve should be the active tab.
  await page.getByTestId('mode-switcher').selectOption('animate');
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-tab-curve')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('curve-editor-pane')).toHaveAttribute('data-active', 'true');
});

test('P6.W5#4 Frame / total + FPS readouts reflect timeStore', async ({ page }) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  // Default duration is 10s × 60fps = 600 frames; default time = 0.
  await expect(page.getByTestId('timeline-dock-frame-readout')).toHaveText('0 / 600');
  await expect(page.getByTestId('timeline-dock-fps-readout')).toHaveText('60 fps');
  // Drive setTime via the dev seam; readout should follow.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time?.getState().setTime(2.5);
  });
  // 2.5s × 60fps = 150.
  await expect(page.getByTestId('timeline-dock-frame-readout')).toHaveText('150 / 600');
  // Changing duration updates the total denominator.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time?.getState().setDuration(4);
  });
  // After setDuration(4), current time stays 2.5 → 150 / (4 * 60 = 240).
  await expect(page.getByTestId('timeline-dock-frame-readout')).toHaveText('150 / 240');
});

test('P6.W5#5 channel-row click in Dopesheet does NOT auto-switch tab (D-W5-3)', async ({
  page,
}) => {
  // Seed a layer + channel so the Dopesheet has a row to click.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    const boxId = Object.entries(dag.state.nodes).find(([, n]) => n.type === 'BoxMesh')?.[0];
    if (!boxId) throw new Error('seed box not found');
    if (!Object.values(dag.state.nodes).some((n) => n.type === 'TimeSource')) {
      dag.dispatch({ type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} });
    }
    const timeId =
      Object.entries(dag.state.nodes).find(([, n]) => n.type === 'TimeSource')?.[0] ?? 'time';
    dag.dispatch({
      type: 'addNode',
      nodeId: 'box_layer',
      nodeType: 'AnimationLayer',
      params: { name: 'L', mute: false, solo: false, weight: 1, boneMask: [] },
    });
    dag.dispatch({
      type: 'addNode',
      nodeId: 'box_pos_channel',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'intensity',
        target: boxId,
        paramPath: 'intensity',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 5, easing: 'linear' },
        ],
      },
    });
    dag.dispatch({
      type: 'connect',
      from: { node: timeId, socket: 'out' },
      to: { node: 'box_pos_channel', socket: 'time' },
    });
    dag.dispatch({
      type: 'connect',
      from: { node: 'box_pos_channel', socket: 'out' },
      to: { node: 'box_layer', socket: 'animation' },
    });
  });
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-tab-dopesheet')).toHaveAttribute('data-active', 'true');
  // P6 W9: select the channel via the timelineSelection seam (the
  // TimelineCanvas paints rows onto a <canvas>; the old DOM
  // `channel-row-box_pos_channel` click no longer exists). This is
  // exactly what the SVG row's onClick did — setActiveChannel — so the
  // D-W5-3 "no auto tab switch" invariant is tested identically.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_timeline_selection!.getState().setActiveChannel('box_pos_channel');
  });
  // activeChannelId now set, BUT the tab stayed on Dopesheet — D-W5-3.
  await expect(page.getByTestId('timeline-tab-dopesheet')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('timeline-tab-curve')).toHaveAttribute('data-active', 'false');
  // Verify via the dev seam too (DOM and store agree).
  const activeTab = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_timeline_dock?.getState().activeTab;
  });
  expect(activeTab).toBe('dopesheet');
});

test('P6.W5#6 Curve Editor placeholder is visible after explicit tab switch', async ({
  page,
}) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  await page.getByTestId('timeline-tab-curve').click();
  // No channel selected yet — Curve Editor shows the prompt.
  await expect(page.getByTestId('curve-editor')).toContainText('Select a channel row');
});
