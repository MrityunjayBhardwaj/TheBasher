// P3 Wave C acceptance — timeline drawer + dopesheet/curve editor visibility.
//
// Closed-by-default to preserve the existing pixel-diff baselines (H13).
// Toggling opens the drawer; dopesheet + curve editor panes appear; an
// empty project shows the "no animation channels" hint.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, unknown> } } };
  __basher_viewport?: { getState: () => { timelineDrawerOpen: boolean } };
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
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_viewport);
  });
  // P6 D-UX-1: timeline dock is mode-gated to Animate. P3's drawer + dopesheet
  // assertions all require the dock visible; switch into Animate before each
  // spec. The drawer's internal data-open state (from P3 Wave C) is unchanged
  // — it still defaults to closed; the toggle still opens it.
  await page.getByTestId('mode-switcher').selectOption('animate');
});

test('P3#1 timeline drawer is closed by default (preserves baseline)', async ({ page }) => {
  await expect(page.getByTestId('timeline-drawer')).toBeVisible();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'false');
  // Dopesheet + curve editor panes are NOT in the DOM when closed (they
  // render conditionally — keeps the slot height tight).
  await expect(page.getByTestId('timeline-canvas-pane')).toHaveCount(0);
  await expect(page.getByTestId('curve-editor-pane')).toHaveCount(0);
});

test('P3#2 toggling the drawer opens it and reveals dopesheet + curve editor panes', async ({
  page,
}) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'true');
  // P6 W5 (D-W5-1): both panes mount whenever the drawer is open; the
  // inactive pane is in the DOM but hidden via `display: none` so V8
  // store subscriptions and scroll state survive a tab switch. Default
  // active tab is Dopesheet (D-W5-2 default).
  await expect(page.getByTestId('timeline-canvas-pane')).toBeVisible();
  await expect(page.getByTestId('timeline-canvas-pane')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('curve-editor-pane')).toHaveCount(1);
  await expect(page.getByTestId('curve-editor-pane')).toHaveAttribute('data-active', 'false');
  // P6 W9: the SVG Dopesheet's "No animation channels" hint text was a
  // DOM node; TimelineCanvas paints onto a <canvas> and exposes the
  // honest DAG-derived count via the data-channel-count mirror attr
  // instead. Empty seed scene → zero animation channels.
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-channel-count', '0');
});

test('P3#3 dopesheet renders a layer + channel after a Mutator chain runs', async ({ page }) => {
  // Build the substrate: addNode AnimationLayer (wrapping the seed box) +
  // a KeyframeChannelVec3 with two keyframes + connect chain. Drives the
  // dopesheet to render one layer row + one channel row.
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow & {
      __basher_dag: {
        getState: () => {
          state: {
            nodes: Record<
              string,
              { type: string; inputs: Record<string, { node: string; socket: string }> }
            >;
          };
          dispatch: (op: unknown) => void;
        };
      };
    };
    const dag = w.__basher_dag.getState();
    // Find the seed box id.
    const boxId = Object.entries(dag.state.nodes).find(([, n]) => n.type === 'BoxMesh')?.[0];
    if (!boxId) throw new Error('seed box not found');
    // TimeSource (P2 may seed one — fall through if so).
    if (!Object.values(dag.state.nodes).some((n) => n.type === 'TimeSource')) {
      dag.dispatch({ type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} });
    }
    const timeId =
      Object.entries(dag.state.nodes).find(([, n]) => n.type === 'TimeSource')?.[0] ?? 'time';
    dag.dispatch({
      type: 'addNode',
      nodeId: 'box_layer',
      nodeType: 'AnimationLayer',
      params: { name: 'Bounce', mute: false, solo: false, weight: 1, boneMask: [] },
    });
    dag.dispatch({
      type: 'addNode',
      nodeId: 'box_pos_channel',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target: boxId,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'cubic' },
          { time: 1, value: [0, 2, 0], easing: 'cubic' },
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
    dag.dispatch({
      type: 'connect',
      from: { node: boxId, socket: 'out' },
      to: { node: 'box_layer', socket: 'target' },
    });
  });
  await page.getByTestId('timeline-drawer-toggle').click();
  // P6 W9: the SVG Dopesheet rendered a DOM `layer-{id}` group with
  // per-channel `channel-row-{id}` + per-keyframe `keyframe-diamond-*`
  // nodes. TimelineCanvas paints all of that onto a 2D <canvas>
  // (D-W9-2/D-W9-4 — no per-row DOM, no pixel-diffing). The honest
  // equivalent of "one channel row + two diamonds rendered" is the
  // DAG-derived mirror-attr contract: one channel collected, two
  // keyframes culled-and-painted. collectChannelRows deliberately
  // flattens layer-wired channels (mute/solo chrome is a deferred
  // drawer concern, NOT on the canvas surface in W9 — see
  // TimelineCanvas.tsx collectChannelRows comment); the lost
  // mute/solo DOM affordance's Op path is still covered by P3#5.
  const canvas = page.getByTestId('timeline-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-channel-count', '1');
  await expect(canvas).toHaveAttribute('data-rendered-keyframes', '2');
});

test('P3#4 clicking a channel row makes the curve editor render its track', async ({ page }) => {
  // Re-use the substrate from P3#3 — duplicated inline rather than
  // factored to keep each test self-sufficient.
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow & {
      __basher_dag: {
        getState: () => {
          state: { nodes: Record<string, { type: string }> };
          dispatch: (op: unknown) => void;
        };
      };
    };
    const dag = w.__basher_dag.getState();
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
      params: {},
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
  // P6 W5 (D-W5-3): channel selection happens on the dopesheet (default
  // tab); user must explicitly switch to the Curve Editor tab to see
  // the track. P6 W9: the dopesheet is now a 2D canvas — selecting a
  // channel routes through the timelineSelection seam (the exact action
  // the old SVG row's onClick performed: setActiveChannel). No
  // auto-switch — selecting a channel only updates activeChannelId.
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_timeline_selection: {
        getState: () => {
          setActiveChannel: (id: string) => void;
          activeChannelId: string | null;
        };
      };
    };
    w.__basher_timeline_selection.getState().setActiveChannel('box_pos_channel');
  });
  const active = await page.evaluate(() => {
    const w = window as unknown as {
      __basher_timeline_selection: {
        getState: () => { activeChannelId: string | null };
      };
    };
    return w.__basher_timeline_selection.getState().activeChannelId;
  });
  expect(active).toBe('box_pos_channel');
  await page.getByTestId('timeline-tab-curve').click();
  // KeyframeChannelNumber renders one track.
  await expect(page.getByTestId('curve-track-0')).toBeVisible();
});

// P6 W9: this spec exercised the SVG Dopesheet's per-layer mute toggle
// (`layer-mute-{id}`, rendered by LayerRowControls inside Dopesheet's
// LayerSection). TimelineCanvas (D-W9-2) flattens layer-wired channels
// and deliberately does NOT paint mute/solo chrome — that affordance is
// a deferred drawer concern with no mount in W9 (see collectChannelRows
// in TimelineCanvas.tsx). The V1 invariant it tested (UI toggle →
// setParam Op) is unchanged at the store/Op-builder level; only the UI
// surface is gone. Skipped honestly rather than faked (dispatching the
// Op directly here would assert dispatch works, not that a UI toggle
// dispatches it). Re-enable when a wave re-mounts layer mute/solo
// controls onto/beside TimelineCanvas. H29 hand-resolution: deferral
// recorded, not silent false-green.
test.skip('P3#5 mute toggle on layer row dispatches a setParam Op (V1 holds) — DEFERRED: layer mute/solo chrome not on the W9 TimelineCanvas surface', async () => {
  // intentionally empty — see the block comment above for the W9
  // rationale and the re-enable condition.
});

test('P3#6 DiffBar shows the time-range when an animation Mutator chain is pending', async ({
  page,
}) => {
  // Stage a pending diff carrying a KeyframeChannelVec3 addNode with two
  // keyframes spanning t=0 → t=2. The DiffBar's time-range indicator
  // should surface "0 → 2s" so the user sees where the change lands in time.
  await page.waitForFunction(() => {
    const w = window as unknown as { __basher_diff?: unknown };
    return Boolean(w.__basher_diff);
  });
  await page.evaluate(async () => {
    const w = window as unknown as {
      __basher_dag: { getState: () => { state: unknown } };
      __basher_diff: {
        getState: () => {
          propose: (
            state: unknown,
            ops: unknown[],
            description: string,
            opSources?: string[],
            closureSpec?: unknown,
            warnings?: string[],
          ) => unknown;
        };
      };
    };
    const ops = [
      {
        type: 'addNode',
        nodeId: 'ch_test',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'pos',
          target: 'box',
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'cubic' },
            { time: 2, value: [0, 5, 0], easing: 'cubic' },
          ],
        },
      },
    ];
    const state = w.__basher_dag.getState().state;
    w.__basher_diff
      .getState()
      .propose(state, ops, 'test bounce', ['agent:mutator.timeline.addChannel']);
  });
  await expect(page.getByTestId('diffbar-time-range')).toBeVisible();
  await expect(page.getByTestId('diffbar-time-range')).toContainText('0');
  await expect(page.getByTestId('diffbar-time-range')).toContainText('2');
});
