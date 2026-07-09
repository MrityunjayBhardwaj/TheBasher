// NLA lane view — 5B read-only gate (epic #283 Phase 5, inc 5B). Proves the
// fourth dock tab ('nla') mounts a lane pane that MIRRORS the fold: seeded
// Action+Strip renders as a percent-positioned block whose on-screen box
// matches the SAME nlaLaneGeometry computation the component imports (H95 —
// zero literal px below; the spec imports the module), degraded states flip
// data attributes while the block STAYS VISIBLE (authored state shown, live
// state styled), and the tab + strips persist across reload.
//
// Hygiene (R3): every test wipes OPFS + the persisted dock-tab key and
// reloads (persisted-tab/DAG leakage between specs is the known trap). Every
// seeding dispatch RETURNS the DispatchResult and asserts res.ok (B26 — a
// silent {ok:false} leaves the DAG unchanged and mis-attributes the failure).
//
// 5B is read-only: no gesture cases here (drag/resize/M/S/reorder land in
// 5C's nla-lane-gesture spec). The ruler scrub is transport, not authoring.

import { test, expect, type Page } from './_fixtures';
import {
  NLA_HEADER_WIDTH_PX,
  spanToPercent,
  stripPlacedRange,
} from '../../src/timeline/nlaLaneGeometry';
import { DEFAULT_VIEW } from '../../src/timeline/timelineView';

interface DispatchResult {
  ok: boolean;
  reason?: string;
}

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown) => unknown;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_time?: { getState: () => { durationSeconds: number } };
  __basher_timeline_dock?: { getState: () => { activeTab: string } };
  __basher_dispatchMutator?: (name: string, spec: unknown, intent: string) => DispatchResult;
}

const FPS = 60;

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
  await page.waitForFunction(
    () =>
      !!(window as unknown as BasherWindow).__basher_dag &&
      !!(window as unknown as BasherWindow).__basher_time &&
      !!(window as unknown as BasherWindow).__basher_timeline_dock &&
      !!(window as unknown as BasherWindow).__basher_dispatchMutator,
    { timeout: 20_000 },
  );
});

// B26: every dispatch helper RETURNS the result and asserts ok.
async function okDispatch(page: Page, name: string, spec: unknown, intent: string) {
  const res = await page.evaluate(
    ([n, s, i]) =>
      (window as unknown as BasherWindow).__basher_dispatchMutator!(n as string, s, i as string),
    [name, spec, intent] as const,
  );
  expect(res.ok, `${name} rejected: ${res.reason}`).toBe(true);
  return res;
}

// Seed the 4A shape: a 0→2s vec3 walk Action placed on n_box, auto-track.
async function seedWalkStrip(page: Page) {
  await okDispatch(
    page,
    'mutator.nla.createAction',
    {
      name: 'walk',
      actionId: 'nla_act',
      channels: [
        {
          valueType: 'vec3',
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 2, value: [2, 1, 0], easing: 'linear' },
          ],
        },
      ],
    },
    'author a walk Action',
  );
  await okDispatch(
    page,
    'mutator.nla.addStrip',
    { action: 'nla_act', target: 'n_box', stripId: 'nla_s1' },
    'place the walk on n_box',
  );
}

async function openNlaTab(page: Page) {
  await page.getByTestId('floating-toolbar-timeline').click();
  await page.getByTestId('timeline-tab-nla').click();
  await expect(page.getByTestId('timeline-tab-nla')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('nla-pane')).toHaveAttribute('data-active', 'true');
}

test('NLA 5B#1 — nla tab activates the pane; siblings stay mounted (hidden); empty state names the agent road', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);

  // Hidden-not-unmounted siblings (D-W5-1): all four panes in the DOM.
  await expect(page.getByTestId('timeline-canvas-pane')).toHaveCount(1);
  await expect(page.getByTestId('timeline-canvas-pane')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('curve-editor-pane')).toHaveCount(1);
  await expect(page.getByTestId('light-studio-pane')).toHaveCount(1);

  // The keyframe DockToolbar is hidden for 'nla' (it acts on timelineSelection
  // channels, not strips).
  await expect(page.getByTestId('timeline-dock-toolbar')).toHaveCount(0);

  // Empty state (§1.6): names the agent road; NO Add-Track button anywhere.
  await expect(page.getByTestId('nla-empty-state')).toBeVisible();
  await expect(page.getByTestId('nla-empty-state')).toContainText('mutator.nla.createAction');
  await expect(page.getByText('Add Track')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('NLA 5B#2 — seeded strip renders at the geometry module placement (H95, ±1px)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkStrip(page);

  // One auto-created track row; the strip block + inert header controls render.
  await expect(page.getByTestId('nla-track-row-nla_track_1')).toBeVisible();
  await expect(page.locator('[data-testid^="nla-track-row-"]')).toHaveCount(1);
  await expect(page.getByTestId('nla-strip-nla_s1')).toBeVisible();
  await expect(page.getByTestId('nla-ruler')).toBeVisible();
  await expect(page.getByTestId('nla-playhead')).toHaveCount(1);
  await expect(page.getByTestId('nla-track-mute-nla_track_1')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByTestId('nla-track-solo-nla_track_1')).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Placement (H95): the block's box vs the lane's box must equal the SAME
  // spanToPercent(stripPlacedRange(...)) the component computes — imported
  // from nlaLaneGeometry, never mirrored. Fresh reload → view is DEFAULT_VIEW.
  const duration = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_time!.getState().durationSeconds,
  );
  const totalFrames = Math.max(1, Math.round(duration * FPS));
  // walk Action domain: keys 0..2s → actLen 2; strip start 0, timeScale 1, repeat 1.
  const range = stripPlacedRange(0, 2, 1, 1);
  const { leftPct, widthPct } = spanToPercent(
    range.start,
    range.end,
    FPS,
    totalFrames,
    DEFAULT_VIEW,
  );

  const laneBox = await page.getByTestId('nla-lane-nla_track_1').boundingBox();
  const stripBox = await page.getByTestId('nla-strip-nla_s1').boundingBox();
  expect(laneBox, 'lane box').not.toBeNull();
  expect(stripBox, 'strip box').not.toBeNull();
  const expectedLeft = laneBox!.x + (leftPct / 100) * laneBox!.width;
  const expectedWidth = (widthPct / 100) * laneBox!.width;
  expect(Math.abs(stripBox!.x - expectedLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(stripBox!.width - expectedWidth)).toBeLessThanOrEqual(1);

  // The header column really is the geometry constant wide (same module).
  const rowBox = await page.getByTestId('nla-track-row-nla_track_1').boundingBox();
  expect(Math.abs(laneBox!.x - (rowBox!.x + NLA_HEADER_WIDTH_PX))).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});

test('NLA 5B#3 — degraded states flip data attributes; the block never hides', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkStrip(page);

  const row = page.getByTestId('nla-track-row-nla_track_1');
  const strip = page.getByTestId('nla-strip-nla_s1');
  await expect(row).toHaveAttribute('data-muted', 'false');
  await expect(strip).toHaveAttribute('data-degraded', 'false');
  await expect(strip).toHaveAttribute('data-live', 'true');

  // Mute the track raw (the sanctioned falsify road) → the row + strip flag,
  // the M toggle shows pressed, and the block STAYS visible (§1.3/§4.2).
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'nla_track_1',
      paramPath: 'mute',
      value: true,
    }),
  );
  await expect(row).toHaveAttribute('data-muted', 'true');
  await expect(strip).toHaveAttribute('data-muted', 'true');
  await expect(strip).toHaveAttribute('data-degraded', 'true');
  await expect(strip).toHaveAttribute('data-live', 'false');
  await expect(strip).toBeVisible();
  await expect(page.getByTestId('nla-track-mute-nla_track_1')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Revert → flags clear.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'nla_track_1',
      paramPath: 'mute',
      value: false,
    }),
  );
  await expect(row).toHaveAttribute('data-muted', 'false');
  await expect(strip).toHaveAttribute('data-degraded', 'false');
  await expect(strip).toHaveAttribute('data-live', 'true');

  // Strip-level mute (the Strip.muted param — no mutator covers it).
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'nla_s1',
      paramPath: 'muted',
      value: true,
    }),
  );
  await expect(strip).toHaveAttribute('data-muted', 'true');
  await expect(strip).toHaveAttribute('data-live', 'false');
  await expect(strip).toBeVisible();

  expect(errors).toEqual([]);
});

test('NLA 5B#4 — the nla tab and the strip persist across reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkStrip(page);
  await expect(page.getByTestId('nla-strip-nla_s1')).toBeVisible();

  // Persist the seeded DAG NOW (the autosave is idle-debounced at 10s —
  // boot.ts AUTOSAVE_IDLE_MS): Cmd/Ctrl+S drives saveCurrent, and the
  // project-tab dirty dot clearing is the deterministic "save flushed" signal.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => !!(window as unknown as BasherWindow).__basher_timeline_dock, {
    timeout: 20_000,
  });

  // Persisted tab (D-W5-2 self-healing coercion accepted 'nla').
  const persisted = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_timeline_dock!.getState().activeTab,
  );
  expect(persisted).toBe('nla');

  // Open the drawer: nla is still the active tab and the persisted DAG still
  // renders the strip.
  await page.getByTestId('floating-toolbar-timeline').click();
  await expect(page.getByTestId('timeline-tab-nla')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('nla-pane')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('nla-strip-nla_s1')).toBeVisible();

  expect(errors).toEqual([]);
});
