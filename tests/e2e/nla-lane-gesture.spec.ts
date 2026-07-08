// NLA lane gestures — the 5C PHASE KEYSTONE (epic #283 Phase 5, inc 5C).
// Proves phase-gate item 1: a UI gesture on the REAL :5180 commits through
// the ONE authoring road (setStripTiming / setTrackState / the sanctioned raw
// Strip.muted setParam) and the fold renders it — UI == agent == render ==
// read (H40). Every expected value below is computed by IMPORTING the SAME
// nlaLaneGeometry functions the component calls (H95 — zero literal px or
// mirrored constants in any assertion).
//
// Cases: (1) body drag → start == snapToFrame(xDeltaToSecondsDelta(dx, …)) →
// render==read at 3 scrub times at the NEW placement + a completed drag never
// selects (suppress-click LOCK) while a plain click does; (2) FALSIFY — the
// track M toggle reverts the box to base, un-mute restores; (3) right-handle
// resize → timeScale == resizeRight(…) → render==read inside the stretched
// span; (4) ▲ reorder flips the fold winner (two-strip stack) with ONE order
// dispatch, extremes disabled; (5) keyboard parity — ←/→ nudge (Shift ×10)
// commits the same setStripTiming op, M commits the raw muted road.
//
// Hygiene (R3): every test wipes OPFS + the persisted dock-tab key and
// reloads. Every seeding dispatch RETURNS the DispatchResult and asserts
// res.ok (B26 — a silent {ok:false} leaves the DAG unchanged and
// mis-attributes the failure).

import { test, expect, type Page } from './_fixtures';
import { xDeltaToSecondsDelta, snapToFrame, resizeRight } from '../../src/timeline/nlaLaneGeometry';
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
  __basher_time?: {
    getState: () => { durationSeconds: number; setTime: (s: number) => void };
  };
  __basher_timeline_dock?: { getState: () => { activeTab: string } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position?: [number, number, number] } | null;
  __basher_dispatchMutator?: (name: string, spec: unknown, intent: string) => DispatchResult;
}

const FPS = 60;

const r3 = (p: readonly number[] | null | undefined) =>
  p ? p.map((n) => Math.round(n * 1000) / 1000) : null;

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
      !!(window as unknown as BasherWindow).__basher_mesh_world_position &&
      !!(window as unknown as BasherWindow).__basher_evaluated_transform &&
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

// A held-pose Action = two keys at the same value (the 4C reorder shape).
async function seedConstAction(page: Page, actionId: string, x: number) {
  await okDispatch(
    page,
    'mutator.nla.createAction',
    {
      name: actionId,
      actionId,
      channels: [
        {
          valueType: 'vec3',
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [x, 0, 0], easing: 'linear' },
            { time: 2, value: [x, 0, 0], easing: 'linear' },
          ],
        },
      ],
    },
    'author const action',
  );
}

async function openNlaTab(page: Page) {
  await page.getByTestId('floating-toolbar-timeline').click();
  await page.getByTestId('timeline-tab-nla').click();
  await expect(page.getByTestId('nla-pane')).toHaveAttribute('data-active', 'true');
}

async function totalFramesOf(page: Page): Promise<number> {
  const duration = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_time!.getState().durationSeconds,
  );
  return Math.max(1, Math.round(duration * FPS));
}

async function stripParam(page: Page, stripId: string, param: string): Promise<unknown> {
  return page.evaluate(
    ([id, p]) =>
      (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id as string].params[
        p as string
      ],
    [stripId, param] as const,
  );
}

async function trackParam(page: Page, trackId: string, param: string): Promise<unknown> {
  return stripParam(page, trackId, param);
}

// render vs read at a scrub time (the H40 boundary pair, nla-mutator idiom).
async function renderVsRead(page: Page, t: number) {
  await page.evaluate((time) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(time);
  }, t);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate((time) => {
    const w = window as unknown as BasherWindow;
    return {
      render: w.__basher_mesh_world_position!('n_box'),
      read:
        w.__basher_evaluated_transform!('n_box', {
          time: { frame: 0, seconds: time, normalized: 0 },
        })?.position ?? null,
    };
  }, t);
}

async function expectAt(page: Page, t: number, expected: [number, number, number]) {
  const { render, read } = await renderVsRead(page, t);
  expect(r3(read), `read==render at t=${t}`).toEqual(r3(render)); // H40
  expect(r3(render), `render at t=${t}`).toEqual(expected);
}

/** Press at the center of `box`, drag horizontally by `dx`, release
 *  (the p-compositor-bar-drag helper shape). */
async function dragX(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  dx: number,
) {
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 8 });
  await page.mouse.up();
}

test('NLA 5C#1 — KEYSTONE: body drag commits setStripTiming{start} at the geometry-computed value; render==read at the new placement; drag never selects', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkStrip(page);

  const totalFrames = await totalFramesOf(page);
  const laneBox = await page.getByTestId('nla-lane-nla_track_1').boundingBox();
  const stripBox = await page.getByTestId('nla-strip-nla_s1').boundingBox();
  expect(laneBox, 'lane box').not.toBeNull();
  expect(stripBox, 'strip box').not.toBeNull();

  // Drag the strip BODY by a known px delta. The expected start comes from
  // the SAME module the component imports (H95): lane width measured once,
  // px→seconds via the shared view window, snapped to the frame grid.
  const dx = 120;
  const expectedStart = snapToFrame(
    0 + xDeltaToSecondsDelta(dx, laneBox!.width, FPS, totalFrames, DEFAULT_VIEW),
    FPS,
  );
  expect(expectedStart).toBeGreaterThan(0); // the drag is a real move

  await dragX(page, stripBox!, dx);

  const start = (await stripParam(page, 'nla_s1', 'start')) as number;
  expect(start).toBeCloseTo(expectedStart, 6);

  // A completed drag did NOT select (suppress-click LOCK); a plain click does.
  await expect(page.getByTestId('nla-strip-nla_s1')).toHaveAttribute('data-selected', 'false');
  await page.getByTestId('nla-strip-nla_s1').click();
  await expect(page.getByTestId('nla-strip-nla_s1')).toHaveAttribute('data-selected', 'true');

  // render==read at 3 scrub times proving the NEW placement: the 0→2s ramp
  // [0,0,0]→[2,1,0] now runs over [start, start+2] (extrapolate holds ends).
  await expectAt(page, start, [0, 0, 0]);
  await expectAt(page, start + 1, [1, 0.5, 0]);
  await expectAt(page, start + 2, [2, 1, 0]);

  expect(errors).toEqual([]);
});

test('NLA 5C#2 — FALSIFY: the track M toggle reverts the box to base; un-mute restores (setTrackState via the UI)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkStrip(page);

  // Mid-ramp value with the strip live.
  await expectAt(page, 1, [1, 0.5, 0]);

  // Mute via the header toggle → the whole track drops from the fold → base.
  await page.getByTestId('nla-track-mute-nla_track_1').click();
  await expect(page.getByTestId('nla-track-mute-nla_track_1')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await trackParam(page, 'nla_track_1', 'mute')).toBe(true);
  await expectAt(page, 1, [0, 0, 0]);

  // Un-mute → restored.
  await page.getByTestId('nla-track-mute-nla_track_1').click();
  expect(await trackParam(page, 'nla_track_1', 'mute')).toBe(false);
  await expectAt(page, 1, [1, 0.5, 0]);

  expect(errors).toEqual([]);
});

test('NLA 5C#3 — right-handle resize commits setStripTiming{timeScale} == resizeRight(...); render==read inside the stretched span', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkStrip(page);

  const totalFrames = await totalFramesOf(page);
  const laneBox = await page.getByTestId('nla-lane-nla_track_1').boundingBox();
  const handleBox = await page.getByTestId('nla-strip-handle-right-nla_s1').boundingBox();
  expect(laneBox, 'lane box').not.toBeNull();
  expect(handleBox, 'right handle box').not.toBeNull();

  // Stretch the strip: newEnd = oldEnd + the px delta in seconds; the
  // expected timeScale is the SAME resizeRight the component commits (H95).
  const dx = 120;
  const dSec = xDeltaToSecondsDelta(dx, laneBox!.width, FPS, totalFrames, DEFAULT_VIEW);
  const expected = resizeRight(0, 2, 2 + dSec, 1).timeScale;
  expect(expected).toBeGreaterThan(1); // a real stretch

  await dragX(page, handleBox!, dx);

  const timeScale = (await stripParam(page, 'nla_s1', 'timeScale')) as number;
  expect(timeScale).toBeCloseTo(expected, 6);
  // start untouched by a right-handle resize.
  expect((await stripParam(page, 'nla_s1', 'start')) as number).toBeCloseTo(0, 6);

  // Inside the stretched span: at t = timeScale the Action-local time is 1
  // (mid-ramp) → [1, 0.5, 0]; the span end lands at 2·timeScale → [2,1,0].
  await expectAt(page, timeScale, [1, 0.5, 0]);
  await expectAt(page, 2 * timeScale, [2, 1, 0]);

  expect(errors).toEqual([]);
});

test('NLA 5C#4 — ▲ reorder flips the fold winner with ONE order dispatch; extremes are disabled', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);

  // Two held poses on their own tracks (the 4C shape): A=[-4], B=[4]; both
  // order 0 → asc sort tie-breaks tkA<tkB → tkB folds last (top) → [4,0,0].
  await seedConstAction(page, 'nla_actA', -4);
  await seedConstAction(page, 'nla_actB', 4);
  await okDispatch(
    page,
    'mutator.nla.addStrip',
    { action: 'nla_actA', target: 'n_box', stripId: 'sA', trackId: 'tkA' },
    'place A',
  );
  await okDispatch(
    page,
    'mutator.nla.addStrip',
    { action: 'nla_actB', target: 'n_box', stripId: 'sB', trackId: 'tkB' },
    'place B',
  );
  await expectAt(page, 1, [4, 0, 0]);

  // Display top = tkB, bottom = tkA → ▲ disabled on top, ▼ disabled on bottom
  // (no junk dispatch at the extremes — §2.4).
  await expect(page.getByTestId('nla-track-up-tkB')).toBeDisabled();
  await expect(page.getByTestId('nla-track-down-tkA')).toBeDisabled();
  await expect(page.getByTestId('nla-track-up-tkA')).toBeEnabled();

  // ▲ on tkA: ONE dispatch on ONE track — midpointOrder(0, null) = past the
  // extreme → strictly ABOVE tkB's order 0. The fold winner flips → [-4,0,0].
  await page.getByTestId('nla-track-up-tkA').click();
  const orderA = (await trackParam(page, 'tkA', 'order')) as number;
  const orderB = (await trackParam(page, 'tkB', 'order')) as number;
  expect(orderA).toBeGreaterThan(orderB); // strictly beyond the neighbor, never equal
  await expectAt(page, 1, [-4, 0, 0]);

  // The display re-derived: tkA is now the top row → its ▲ is the disabled one.
  await expect(page.getByTestId('nla-track-up-tkA')).toBeDisabled();
  await expect(page.getByTestId('nla-track-down-tkA')).toBeEnabled();

  expect(errors).toEqual([]);
});

test('NLA 5C#5 — keyboard parity: ←/→ nudge start by 1 frame (Shift = 10) through setStripTiming; M commits the raw muted road', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkStrip(page);

  const strip = page.getByTestId('nla-strip-nla_s1');
  await strip.focus();

  // Enter selects (§2.8).
  await page.keyboard.press('Enter');
  await expect(strip).toHaveAttribute('data-selected', 'true');

  // → = +1 frame; the commit is the SAME snapToFrame(setStripTiming) op.
  await page.keyboard.press('ArrowRight');
  expect((await stripParam(page, 'nla_s1', 'start')) as number).toBeCloseTo(
    snapToFrame(1 / FPS, FPS),
    9,
  );

  // Shift+→ = +10 frames.
  await page.keyboard.press('Shift+ArrowRight');
  expect((await stripParam(page, 'nla_s1', 'start')) as number).toBeCloseTo(
    snapToFrame(11 / FPS, FPS),
    9,
  );

  // ← = −1 frame.
  await page.keyboard.press('ArrowLeft');
  expect((await stripParam(page, 'nla_s1', 'start')) as number).toBeCloseTo(
    snapToFrame(10 / FPS, FPS),
    9,
  );

  // M = the sanctioned raw Strip.muted setParam road (§2.5).
  await page.keyboard.press('m');
  expect(await stripParam(page, 'nla_s1', 'muted')).toBe(true);
  await expect(strip).toHaveAttribute('data-muted', 'true');
  await page.keyboard.press('m');
  expect(await stripParam(page, 'nla_s1', 'muted')).toBe(false);

  // Esc clears the selection (§2.8).
  await page.keyboard.press('Escape');
  await expect(strip).toHaveAttribute('data-selected', 'false');

  expect(errors).toEqual([]);
});

// #285 — the pane's handled keys must NOT double-fire the global shortcuts:
// M is the app-wide projection toggle, S the Blender scale alias, Esc the
// clear-3D-selection ladder. The pane stopPropagation-shields every key it
// handles (the same class of shield the add-strip popover applies to Tab).
test('NLA 5C#6 — pane keys are shielded: M keeps the projection, S keeps the tool, Esc keeps the 3D selection (#285)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkStrip(page);

  type StoreSeams = {
    __basher_viewport?: { getState: () => { cameraProjection: string } };
    __basher_editor?: { getState: () => { activeTool: string } };
    __basher_selection?: {
      getState: () => { primaryNodeId: string | null; select: (id: string) => void };
    };
  };
  const seams = () =>
    page.evaluate(() => {
      const w = window as unknown as StoreSeams;
      return {
        projection: w.__basher_viewport!.getState().cameraProjection,
        tool: w.__basher_editor!.getState().activeTool,
        selected3d: w.__basher_selection!.getState().primaryNodeId,
      };
    });

  // Give the Esc case something global to lose: select the box in 3D.
  await page.evaluate(() => {
    (window as unknown as StoreSeams).__basher_selection!.getState().select('n_box');
  });
  const before = await seams();
  expect(before.selected3d).toBe('n_box');

  // M on a focused strip mutes the strip WITHOUT flipping the projection.
  const strip = page.getByTestId('nla-strip-nla_s1');
  await strip.focus();
  await page.keyboard.press('m');
  await expect(strip).toHaveAttribute('data-muted', 'true');
  await page.keyboard.press('m'); // restore
  await expect(strip).toHaveAttribute('data-muted', 'false');

  // S (and M) on a focused track header solo/mute the track WITHOUT
  // switching the transform tool or the projection.
  const header = page.getByTestId('nla-track-header-nla_track_1');
  await header.focus();
  await page.keyboard.press('s');
  await expect(page.getByTestId('nla-track-solo-nla_track_1')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('s'); // restore
  await page.keyboard.press('m');
  await page.keyboard.press('m'); // restore

  // Esc with an NLA selection clears ONLY the NLA selection.
  await strip.focus();
  await page.keyboard.press('Enter');
  await expect(strip).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(strip).toHaveAttribute('data-selected', 'false');

  const after = await seams();
  expect(after.projection).toBe(before.projection); // M never reached the global toggle
  expect(after.tool).toBe(before.tool); // S never reached the scale alias
  expect(after.selected3d).toBe('n_box'); // Esc never reached the 3D clear

  expect(errors).toEqual([]);
});
