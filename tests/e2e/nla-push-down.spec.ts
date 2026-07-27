// NLA "push down" — inc 5E (epic #283 Phase 5; UI-SPEC §2.7 LOCKED mechanism).
// Proves the ONE director road that MINTS an Action without the agent: the
// selected object's bare keyframe channels become an Action + a Strip placing
// it back (start = the channels' min key time), the bare channel nodes are
// DELETED (no double-drive — bare channels fold below strips,
// layeredChannels.ts:224-226), all as ONE atomic undo entry.
//
// The three-part observation this spec exists for:
//   1. BYTE-IDENTICAL placement — render==read at the SAME 3 scrub times
//      (r3) before and after the push-down (a double-drive or a lossy
//      channel→ActionChannel mapping would change the fold);
//   2. the bare channel nodes are GONE and Action/Strip/Track EXIST;
//   3. ONE undo (the app's real undo road — the p151-apply-transform SC-5
//      precedent, `__basher_dag.getState().undo()`) restores the channels,
//      removes Action/Strip/Track, and render matches BEFORE again.
//
// Geometry (H95): the strip block's placement assertion imports the SAME
// nlaLaneGeometry functions the component renders with — zero literal px.
// Hygiene (R3): OPFS + persisted dock-tab wiped per test. Every dispatch
// helper RETURNS the result and asserts res.ok (B26).

import { test, expect, type Page } from './_fixtures';
import { spanToPercent, stripPlacedRange } from '../../src/timeline/nlaLaneGeometry';
import { DEFAULT_VIEW } from '../../src/timeline/timelineView';

interface DispatchResult {
  ok: boolean;
  reason?: string;
}

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      undo: () => void;
      undoStack: unknown[];
    };
  };
  __basher_time?: {
    getState: () => { durationSeconds: number; setTime: (s: number) => void };
  };
  __basher_selection?: {
    getState: () => { select: (id: string | null) => void };
  };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position?: [number, number, number] } | null;
  __basher_dispatchMutator?: (name: string, spec: unknown, intent: string) => DispatchResult;
  __basher_nlaPushDown?: (targetId: string) => DispatchResult;
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
      !!(window as unknown as BasherWindow).__basher_selection &&
      !!(window as unknown as BasherWindow).__basher_mesh_world_position &&
      !!(window as unknown as BasherWindow).__basher_evaluated_transform &&
      !!(window as unknown as BasherWindow).__basher_dispatchMutator &&
      !!(window as unknown as BasherWindow).__basher_nlaPushDown,
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

// Seed n_box with a BARE 0→2s vec3 position ramp through the shipped keyframe
// mutator road (addChannel with an initial key + a second keyframe).
async function seedBareRamp(page: Page) {
  await okDispatch(
    page,
    'mutator.timeline.addChannel',
    {
      target: 'n_box',
      paramPath: 'position',
      valueType: 'vec3',
      channelId: 'n_box_position_channel',
      initialKeyframe: { time: 0, value: [0, 0, 0], easing: 'linear' },
    },
    'seed a bare position channel',
  );
  await okDispatch(
    page,
    'mutator.timeline.keyframe',
    { channelId: 'n_box_position_channel', time: 2, value: [2, 1, 0], easing: 'linear' },
    'second bare key',
  );
}

async function openNlaTab(page: Page) {
  await page.getByTestId('floating-toolbar-timeline').click();
  await page.getByTestId('timeline-tab-nla').click();
  await expect(page.getByTestId('nla-pane')).toHaveAttribute('data-active', 'true');
}

async function selectNode(page: Page, id: string | null) {
  await page.evaluate(
    (nodeId) => (window as unknown as BasherWindow).__basher_selection!.getState().select(nodeId),
    id,
  );
}

// render vs read at a scrub time (the H40 boundary pair, nla-lane idiom).
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

/** Node ids of a given type, from the live DAG. */
async function nodeIdsOfType(page: Page, type: string): Promise<string[]> {
  return page.evaluate((t) => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    return Object.entries(nodes)
      .filter(([, n]) => n.type === t)
      .map(([id]) => id);
  }, type);
}

async function nodeExists(page: Page, id: string): Promise<boolean> {
  return page.evaluate(
    (nodeId) => !!(window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[nodeId],
    id,
  );
}

async function undoStackLength(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as BasherWindow).__basher_dag!.getState().undoStack.length,
  );
}

const TIMES = [0, 1, 2] as const;

test('NLA 5E#1 — push down: Action+Strip minted, bare channels GONE, render==read BYTE-IDENTICAL at 3 times, ONE undo restores everything', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await seedBareRamp(page);

  // BEFORE: render==read at 3 scrub times over the bare-channel fold.
  const before: Array<{ render: unknown; read: unknown }> = [];
  for (const t of TIMES) {
    const { render, read } = await renderVsRead(page, t);
    expect(r3(read as number[]), `BEFORE read==render at t=${t}`).toEqual(r3(render));
    before.push({ render: r3(render), read: r3(read as number[]) });
  }
  expect(before[1].render, 'mid-ramp sanity').toEqual([1, 0.5, 0]);

  // Select the box → the push-down button arms (≥1 bare channel).
  await selectNode(page, 'n_box');
  await openNlaTab(page);
  const button = page.getByTestId('nla-push-down');
  await expect(button).toBeEnabled();

  const undoLenBefore = await undoStackLength(page);
  await button.click();

  // The vocabulary nodes exist; the bare channel node is GONE from the DAG.
  const actions = await nodeIdsOfType(page, 'Action');
  const strips = await nodeIdsOfType(page, 'Strip');
  const tracks = await nodeIdsOfType(page, 'Track');
  expect(actions).toHaveLength(1);
  expect(strips).toHaveLength(1);
  expect(tracks).toHaveLength(1);
  expect(await nodeExists(page, 'n_box_position_channel')).toBe(false);

  const stripParams = await page.evaluate(
    (id) =>
      (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id].params as Record<
        string,
        unknown
      >,
    strips[0],
  );
  expect(stripParams.target).toBe('n_box');
  expect(stripParams.action).toBe(actions[0]);
  expect(stripParams.start).toBe(0); // the channels' min key time

  // The strip block renders at the channels' key span — expected placement
  // computed by IMPORTING the component's geometry module (H95), ±1px.
  const stripBlock = page.getByTestId(`nla-strip-${strips[0]}`);
  await expect(stripBlock).toBeVisible();
  const laneBox = await page.getByTestId(`nla-lane-${tracks[0]}`).boundingBox();
  const stripBox = await stripBlock.boundingBox();
  expect(laneBox, 'lane box').not.toBeNull();
  expect(stripBox, 'strip box').not.toBeNull();
  const duration = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_time!.getState().durationSeconds,
  );
  const totalFrames = Math.max(1, Math.round(duration * FPS));
  const span = stripPlacedRange(0, 2, 1, 1);
  const { leftPct, widthPct } = spanToPercent(span.start, span.end, FPS, totalFrames, DEFAULT_VIEW);
  expect(Math.abs(stripBox!.x - laneBox!.x - (laneBox!.width * leftPct) / 100)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(stripBox!.width - (laneBox!.width * widthPct) / 100)).toBeLessThanOrEqual(1);

  // BYTE-IDENTICAL placement: render==read at the SAME 3 times equals BEFORE.
  for (let i = 0; i < TIMES.length; i++) {
    const { render, read } = await renderVsRead(page, TIMES[i]);
    expect(r3(read as number[]), `AFTER read==render at t=${TIMES[i]}`).toEqual(r3(render));
    expect(r3(render), `AFTER render == BEFORE render at t=${TIMES[i]}`).toEqual(before[i].render);
  }

  // ONE undo entry covers create+place+delete (K21: a second dispatch would
  // split undo). Drive the app's real undo road (the p151 SC-5 precedent).
  expect(await undoStackLength(page)).toBe(undoLenBefore + 1);
  await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag!.getState().undo());
  expect(await nodeExists(page, 'n_box_position_channel')).toBe(true);
  expect(await nodeIdsOfType(page, 'Action')).toHaveLength(0);
  expect(await nodeIdsOfType(page, 'Strip')).toHaveLength(0);
  expect(await nodeIdsOfType(page, 'Track')).toHaveLength(0);

  // Render matches BEFORE again — the bare-channel fold is back verbatim.
  for (let i = 0; i < TIMES.length; i++) {
    const { render, read } = await renderVsRead(page, TIMES[i]);
    expect(r3(read as number[]), `UNDO read==render at t=${TIMES[i]}`).toEqual(r3(render));
    expect(r3(render), `UNDO render == BEFORE render at t=${TIMES[i]}`).toEqual(before[i].render);
  }

  expect(errors).toEqual([]);
});

test('NLA 5E#2 — no bare channels: the button is DISABLED; a forced call returns {ok:false} AND toasts (H70/B26)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // n_box selected but NO bare channels → disabled with an explanatory title.
  await selectNode(page, 'n_box');
  await openNlaTab(page);
  await expect(page.getByTestId('nla-push-down')).toBeDisabled();

  // Force the composite through the SAME toast funnel the button uses — the
  // rejection is returned AND surfaced, never a silent no-op.
  const res = await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_nlaPushDown!('n_box'),
  );
  expect(res.ok).toBe(false);
  expect(res.reason).toContain('no bare keyframe channels');
  await expect(page.getByTestId('toast-error')).toBeVisible();
  await expect(page.getByTestId('toast-error')).toContainText('no bare keyframe channels');

  // Nothing selected → also disabled.
  await selectNode(page, null);
  await expect(page.getByTestId('nla-push-down')).toBeDisabled();

  expect(errors).toEqual([]);
});

// #479 — the OFFER half, which no unit test can see. The accept's refusal is unit-tested
// (dispatchMutator.test.ts); what only the browser can answer is whether the BUTTON asks
// the same question. A guard on the dispatcher alone leaves the affordance live and the
// mutator refusing — the failure this pairing exists to catch.
//
// The subject is the default project's camera, which HAS bare channels here (so the
// button's other precondition is satisfied and the refusal is the only thing disabling
// it) and which a strip cannot drive: the camera pose is resolved outside the strip fold,
// so pushing down would delete the animation rather than convert it. Cameras become valid
// targets when #480 lands, and this test flips with it.
test('NLA 5E#3 — a camera is REFUSED on both sides: the button is disabled AND a forced call keeps the channel', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // A bare fov ramp on the scene camera, through the shipped keyframe road.
  await okDispatch(
    page,
    'mutator.timeline.addChannel',
    {
      target: 'n_camera',
      paramPath: 'fov',
      valueType: 'number',
      channelId: 'n_camera_fov_channel',
      initialKeyframe: { time: 0, value: 30, easing: 'linear' },
    },
    'seed a bare fov channel on the camera',
  );
  await okDispatch(
    page,
    'mutator.timeline.keyframe',
    { channelId: 'n_camera_fov_channel', time: 2, value: 130, easing: 'linear' },
    'second bare key',
  );

  await selectNode(page, 'n_camera');
  await openNlaTab(page);

  // THE OFFER: disabled, and the title says why — not the generic "no bare channels"
  // message, which would mean the button is disabled for the wrong reason.
  const button = page.getByTestId('nla-push-down');
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /cannot drive a camera/i);

  // THE ACCEPT, through the same toast funnel: refused, and surfaced.
  const res = await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_nlaPushDown!('n_camera'),
  );
  expect(res.ok).toBe(false);
  expect(res.reason).toMatch(/cannot drive a camera/i);
  await expect(page.getByTestId('toast-error')).toBeVisible();

  // THE CONSEQUENCE: the animation is still there. Before the guard this call minted a
  // strip that folds nothing and deleted the channel it converted.
  const nodes = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes,
  );
  expect(nodes['n_camera_fov_channel'], 'the fov channel survives the refusal').toBeTruthy();
  expect(await nodeIdsOfType(page, 'Strip')).toEqual([]);
  expect(await nodeIdsOfType(page, 'Action')).toEqual([]);

  // CONTROL: the same pane, same session — a mesh with bare channels is still offered,
  // so the guard refuses cameras rather than disabling push-down outright.
  await seedBareRamp(page);
  await selectNode(page, 'n_box');
  await expect(button).toBeEnabled();

  expect(errors).toEqual([]);
});
