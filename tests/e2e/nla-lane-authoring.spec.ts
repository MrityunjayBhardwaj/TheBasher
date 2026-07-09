// NLA lane authoring — the 5D phase-gate cases (epic #283 Phase 5, inc 5D;
// UI-SPEC §2.6/§1.5/§6.3.3). Proves the director authors WITHOUT the agent:
// (1) the add-strip popover commits mutator.nla.addStrip with "New track" →
// the track auto-creates and the box animates (render==read, H40) — with the
// H103 probe (document.elementFromPoint at the commit button: a popover
// clipped by the 240px drawer stays count()/toBeVisible()-green, so hit-
// testability is asserted directly); (2) the target list EXCLUDES cameras
// (the documented Phase-3+ KNOWN-LIMIT, Strip.ts:13-16); (3) the strip
// inspector drives setStripBlend — blendMode→combine flips the fold sum over
// a non-zero base, blendIn=1 → the TIME-VARYING influence value
// [0.25,0.125,0] at t=0.5 (the nla-mutator-edit.spec numbers) — and
// setStripTiming (the timeScale field = the keyboard path for edge resize,
// §2.8 LOCK); (4) a forced {ok:false} (Action deleted under the open
// popover) surfaces the reason INLINE + as a toast, the popover STAYS OPEN,
// and the DAG is byte-unchanged (B26/H70 — never a silent no-op); (5) the
// popover is keyboard-complete: Enter opens, focus lands inside, Tab is
// trapped, Esc closes and focus RETURNS to the anchor (UI-SPEC §5).
//
// Hygiene (R3): every test wipes OPFS + the persisted dock-tab key and
// reloads. Every seeding dispatch RETURNS the DispatchResult and asserts
// res.ok (B26) — except case 4's deliberate rejection, asserted {ok:false}
// through the UI surfaces instead.

import { test, expect, type Page } from './_fixtures';

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

// The 4A walk Action: a 0→2s vec3 position ramp [0,0,0]→[2,1,0].
async function seedWalkAction(page: Page) {
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
}

async function openNlaTab(page: Page) {
  await page.getByTestId('floating-toolbar-timeline').click();
  await page.getByTestId('timeline-tab-nla').click();
  await expect(page.getByTestId('nla-pane')).toHaveAttribute('data-active', 'true');
}

async function nodeParam(page: Page, nodeId: string, param: string): Promise<unknown> {
  return page.evaluate(
    ([id, p]) =>
      (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id as string].params[
        p as string
      ],
    [nodeId, param] as const,
  );
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

test('NLA 5D#1 — add-strip flow: popover (hit-testable, H103) commits addStrip with "New track" → track auto-created, box animates (render==read)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);

  // Empty lane, no Actions → the add-strip entry point is present but
  // DISABLED, its title naming the agent road (§2.6).
  await expect(page.getByTestId('nla-empty-state')).toBeVisible();
  await expect(page.getByTestId('nla-add-strip')).toBeDisabled();
  await expect(page.getByTestId('nla-add-strip')).toHaveAttribute(
    'title',
    /mutator\.nla\.createAction/,
  );

  await seedWalkAction(page);
  await expect(page.getByTestId('nla-add-strip')).toBeEnabled();
  expect(await page.locator('[data-testid^="nla-track-row-"]').count()).toBe(0);

  await page.getByTestId('nla-add-strip').click();
  await expect(page.getByTestId('nla-add-strip-popover')).toBeVisible();

  // H103 probe: the commit button must be HIT-TESTABLE, not merely visible —
  // an overlay clipped by the 240px drawer keeps toBeVisible() green while
  // document.elementFromPoint returns whatever paints on top of it.
  const hit = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="nla-add-strip-commit"]') as HTMLElement;
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el === btn || btn.contains(el);
  });
  expect(hit, 'commit button is hit-testable (H103)').toBe(true);

  // Defaults per §2.6: first Action, target n_box (valid non-camera), start =
  // playhead (0), "New track" (empty value → omit trackId → auto-create).
  await expect(page.getByTestId('nla-add-strip-action')).toHaveValue('nla_act');
  await expect(page.getByTestId('nla-add-strip-target')).toHaveValue('n_box');
  await expect(page.getByTestId('nla-add-strip-start')).toHaveValue('0');
  await expect(page.getByTestId('nla-add-strip-track')).toHaveValue('');

  await page.getByTestId('nla-add-strip-commit').click();

  // {ok:true} → popover closes; ONE track auto-created; the strip renders.
  await expect(page.getByTestId('nla-add-strip-popover')).toHaveCount(0);
  expect(await page.locator('[data-testid^="nla-track-row-"]').count()).toBe(1);
  await expect(page.getByTestId('nla-strip-nla_strip_1')).toBeVisible();

  // The box ANIMATES at the placement (render==read at ≥2 times, H40).
  await expectAt(page, 1, [1, 0.5, 0]);
  await expectAt(page, 2, [2, 1, 0]);

  expect(errors).toEqual([]);
});

test('NLA 5D#2 — the target list excludes cameras (the documented dead road, Strip.ts:13-16)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkAction(page);

  await page.getByTestId('nla-add-strip').click();
  await expect(page.getByTestId('nla-add-strip-popover')).toBeVisible();

  const values = await page
    .getByTestId('nla-add-strip-target')
    .locator('option')
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(values).toContain('n_box');
  expect(values, 'cameras are never offered as strip targets').not.toContain('n_camera');

  expect(errors).toEqual([]);
});

test('NLA 5D#3 — inspector: blendMode→combine flips the fold sum; blendIn=1 drives the time-varying influence; timeScale = the keyboard resize path', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkAction(page);
  await okDispatch(
    page,
    'mutator.nla.addStrip',
    { action: 'nla_act', target: 'n_box', stripId: 'nla_s1' },
    'place the walk on n_box',
  );

  // Inspector hidden until a strip is selected; click opens it.
  await expect(page.getByTestId('nla-strip-inspector')).toHaveCount(0);
  await page.getByTestId('nla-strip-nla_s1').click();
  await expect(page.getByTestId('nla-strip-inspector')).toBeVisible();
  await expect(page.getByTestId('nla-strip-field-target')).toHaveText('n_box');

  // blendMode → combine through the inspector select (setStripBlend). Give
  // the box a NON-ZERO base so combine ≠ replace: combine ADDS the sample
  // over the base ([1,0,0] + [1,0.5,0] = [2,0.5,0] at t=1), replace lerps to
  // the sample alone ([1,0.5,0]) — the fold sum observably flips.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'n_box',
      paramPath: 'position',
      value: [1, 0, 0],
    }),
  );
  await page.getByTestId('nla-strip-field-blendMode').selectOption('combine');
  expect(await nodeParam(page, 'nla_s1', 'blendMode')).toBe('combine');
  await expect(page.getByTestId('nla-strip-nla_s1')).toHaveAttribute('data-blend', 'combine');
  await expectAt(page, 1, [2, 0.5, 0]);

  // Falsify: back to replace → the base no longer adds.
  await page.getByTestId('nla-strip-field-blendMode').selectOption('replace');
  expect(await nodeParam(page, 'nla_s1', 'blendMode')).toBe('replace');
  await expectAt(page, 1, [1, 0.5, 0]);

  // Reset the base for the blend-ramp numbers.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'n_box',
      paramPath: 'position',
      value: [0, 0, 0],
    }),
  );

  // blendIn = 1 via the inspector number field (draft → Enter commits ONE
  // setStripBlend). At t=0.5: sample(0.5)·inf(0.5) = [0.5,0.25,0]·0.5 =
  // [0.25,0.125,0] — the TIME-VARYING influence seam, the exact
  // nla-mutator-edit.spec.ts numbers now driven by the UI (H40: UI == agent).
  const blendIn = page.getByTestId('nla-strip-field-blendIn');
  await blendIn.click();
  await blendIn.fill('1');
  await blendIn.press('Enter');
  expect(await nodeParam(page, 'nla_s1', 'blendIn')).toBe(1);
  await expectAt(page, 0.5, [0.25, 0.125, 0]);
  await expectAt(page, 1, [1, 0.5, 0]); // ramp complete → full influence

  // timeScale via the inspector = the KEYBOARD path for edge resize (§2.8
  // LOCK): typing 2 + Enter commits the same setStripTiming op the right
  // handle drags. Placed span doubles → mid-ramp lands at t=2.
  const timeScale = page.getByTestId('nla-strip-field-timeScale');
  await timeScale.click();
  await timeScale.fill('2');
  await timeScale.press('Enter');
  expect(await nodeParam(page, 'nla_s1', 'timeScale')).toBe(2);
  await expectAt(page, 2, [1, 0.5, 0]);

  expect(errors).toEqual([]);
});

test('NLA 5D#4 — a forced rejection surfaces inline + toast; the popover stays open; the DAG is unchanged (B26/H70)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkAction(page);

  await page.getByTestId('nla-add-strip').click();
  await expect(page.getByTestId('nla-add-strip-popover')).toBeVisible();

  // Pull the Action out from under the open popover — the drafted action id
  // is now dangling, so addStrip's precondition gate rejects.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'removeNode',
      nodeId: 'nla_act',
    }),
  );
  await page.getByTestId('nla-add-strip-commit').click();

  // Popover STAYS OPEN with the gate's reason inline…
  await expect(page.getByTestId('nla-add-strip-popover')).toBeVisible();
  await expect(page.getByTestId('nla-add-strip-error')).toContainText('not in DAG');
  // …AND the commitNla funnel toasts it (H70 — never window.alert, never
  // silent).
  await expect(page.getByTestId('toast-error')).toBeVisible();
  await expect(page.getByTestId('toast-error')).toContainText('not in DAG');

  // {ok:false} left the DAG byte-unchanged: no Strip, no Track was created.
  const counts = await page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    const all = Object.values(nodes);
    return {
      strips: all.filter((n) => n.type === 'Strip').length,
      tracks: all.filter((n) => n.type === 'Track').length,
    };
  });
  expect(counts).toEqual({ strips: 0, tracks: 0 });

  expect(errors).toEqual([]);
});

test('NLA 5D#5 — keyboard: Enter opens the popover with focus inside, Tab is trapped, Esc closes and returns focus to the anchor', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openNlaTab(page);
  await seedWalkAction(page);

  // Open with the keyboard only.
  await page.getByTestId('nla-add-strip').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('nla-add-strip-popover')).toBeVisible();

  // Initial focus lands on the first field (§5).
  await expect(page.getByTestId('nla-add-strip-action')).toBeFocused();

  // Tab walks the fields and STAYS inside the dialog (focus trap): a full
  // cycle from the first control returns to it, never escaping to the page.
  const focusable = await page.evaluate(
    () =>
      document.querySelectorAll(
        '[data-testid="nla-add-strip-popover"] select, [data-testid="nla-add-strip-popover"] input, [data-testid="nla-add-strip-popover"] button:not([disabled])',
      ).length,
  );
  for (let i = 0; i < focusable; i += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() =>
      document
        .querySelector('[data-testid="nla-add-strip-popover"]')!
        .contains(document.activeElement),
    );
    expect(inside, `focus stays trapped after Tab #${i + 1}`).toBe(true);
  }
  await expect(page.getByTestId('nla-add-strip-action')).toBeFocused();

  // Esc closes; focus RETURNS to the anchor button.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('nla-add-strip-popover')).toHaveCount(0);
  await expect(page.getByTestId('nla-add-strip')).toBeFocused();

  // Esc also still clears a strip selection in the pane (the popover's
  // capture handler stopPropagation'd only while open).
  expect(errors).toEqual([]);
});
