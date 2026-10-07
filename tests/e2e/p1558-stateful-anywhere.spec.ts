// #1558 — a Solver gives its replayed value wherever it sits, in the running app.
//
// Before this, a Solver's real value reached only a driver wired straight to it. Behind a Math
// node, or inside another Solver's sub-network, it evaluated to its placeholder and the driven
// param did not move. Both are built here and read on both roads at once: what was DRAWN
// (the box material's metalness, `__basher_mesh_material`) and what the read side RESOLVES at
// that time (`__basher_evaluated_param`), at four playhead positions. The recurrence is an
// accumulator of a controller held at x = 0.1, so every expected number can be worked by hand:
// acc(f) = 0.1 + 0.1·f.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState(): {
      state: { outputs: { scene?: { node: string } } };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
  __basher_time: { getState(): { setTime: (seconds: number) => void } };
  __basher_mesh_material?: (id: string) => { metalness: number | null } | null;
  __basher_evaluated_param?: (id: string, path: string, ctx?: unknown) => { value: unknown } | null;
}

const FPS = 60;
const CTL_X = 0.1;

async function boot(page: Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag?.getState().state.outputs.scene && w.__basher_time);
  });
}

function dispatch(page: Page, op: unknown) {
  return page.evaluate(
    (o) => (window as unknown as W).__basher_dag.getState().dispatch(o, 'user', 'e2e'),
    op,
  );
}

const add = (page: Page, nodeId: string, nodeType: string, params: Record<string, unknown> = {}) =>
  dispatch(page, { type: 'addNode', nodeId, nodeType, params });
const wire = (page: Page, from: string, to: string, socket: string) =>
  dispatch(page, {
    type: 'connect',
    from: { node: from, socket: 'out' },
    to: { node: to, socket },
  });

async function controller(page: Page) {
  const scene = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.outputs.scene!.node,
  );
  await add(page, 'e_ctl', 'Null', { position: [CTL_X, 0, 0] });
  await wire(page, 'e_ctl', scene, 'children');
}

const SOURCE = { seedFrame: 0, sourceTransform: { node: 'e_ctl', channel: 'tx' } };

/** `id` = an accumulator Solver: its sub-network is `prev + input`. */
async function accumulator(page: Page, id: string) {
  await add(page, `${id}_prev`, 'BodyInput', { input: 'prev' });
  await add(page, `${id}_in`, 'BodyInput', { input: 'input' });
  await add(page, `${id}_sum`, 'Math', { op: 'add' });
  await wire(page, `${id}_prev`, `${id}_sum`, 'a');
  await wire(page, `${id}_in`, `${id}_sum`, 'b');
  await add(page, id, 'Solver', SOURCE);
  await wire(page, `${id}_sum`, id, 'body');
}

async function drive(page: Page, from: string) {
  await add(page, 'e_drv', 'ParamDriver', {
    // Where the starter cube's metalness really lives: on its data node, under `base`.
    target: 'n_box_data',
    paramPath: 'material.base.metalness',
    blendMode: 'replace',
    order: 0,
  });
  await wire(page, from, 'e_drv', 'in');
}

/** Both roads at `frame`: the drawn box's metalness, and the read side's at that time. */
async function at(page: Page, frame: number, want: number) {
  await page.evaluate(
    (s) => (window as unknown as W).__basher_time.getState().setTime(s),
    frame / FPS,
  );
  const drawn = () =>
    page.evaluate(
      () => (window as unknown as W).__basher_mesh_material?.('n_box')?.metalness ?? null,
    );
  await expect.poll(drawn, { timeout: 10_000 }).toBeCloseTo(want, 4);
  // The read seam defaults to frame 0, so it is told the time: the same one the draw is at.
  const read = await page.evaluate(
    ({ frame, seconds }) =>
      (window as unknown as W).__basher_evaluated_param?.('n_box_data', 'material.base.metalness', {
        time: { frame, seconds, normalized: 0 },
      })?.value ?? null,
    { frame, seconds: frame / FPS },
  );
  expect(read).toBeCloseTo(want, 4);
}

test('#1558 — a Solver behind a Math node moves the object it drives', async ({ page }) => {
  await boot(page);
  await controller(page);
  await accumulator(page, 'e_a');
  await add(page, 'e_mid', 'Math', { op: 'add' });
  await wire(page, 'e_a', 'e_mid', 'a');
  await drive(page, 'e_mid');

  // acc(f) = 0.1 + 0.1·f. Out of order on purpose: a frame's value must not depend on the
  // frames visited before it.
  await at(page, 0, 0.1);
  await at(page, 3, 0.4);
  await at(page, 1, 0.2);
  await at(page, 2, 0.3);
});

test('#1558 — a Solver inside a Solver: the outer one sums the inner one', async ({ page }) => {
  await boot(page);
  await controller(page);
  await accumulator(page, 'e_b');
  // The outer sub-network is `prev + <the inner Solver>`.
  await add(page, 'e_a_prev', 'BodyInput', { input: 'prev' });
  await add(page, 'e_a_sum', 'Math', { op: 'add' });
  await wire(page, 'e_a_prev', 'e_a_sum', 'a');
  await wire(page, 'e_b', 'e_a_sum', 'b');
  await add(page, 'e_a', 'Solver', SOURCE);
  await wire(page, 'e_a_sum', 'e_a', 'body');
  await drive(page, 'e_a');

  // A(0) = 0.1 (seeded with its input); A(f) = A(f-1) + B(f), B(f) = 0.1 + 0.1·f.
  await at(page, 0, 0.1);
  await at(page, 3, 1);
  await at(page, 1, 0.3);
  await at(page, 2, 0.6);
});
