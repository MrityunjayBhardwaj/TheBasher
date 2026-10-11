// #1549 — a Number wired into a Vector3 input, in the running app.
//
// That wire used to be refused. It now converts on the way in, the number on all three axes,
// and the result is DRAWN: a Solver's number feeds a Vec3Math's vector input, which drives the
// starter cube's position. Read on both roads at three playhead positions. The Solver is an
// accumulator of a controller held at x = 0.1, so its number at frame f is 0.1 + 0.1·f. The
// opposite wire, a Vector3 into a Number input, converts too (#1590): the average of its axes.

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
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
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

type Vec3 = [number, number, number];

/** Both roads at `frame`: where the cube was drawn, and what the read side gives for its
 *  position at that time. */
async function at(page: Page, frame: number, want: number) {
  await page.evaluate(
    (s) => (window as unknown as W).__basher_time.getState().setTime(s),
    frame / FPS,
  );
  const drawn = () =>
    page.evaluate(() => (window as unknown as W).__basher_mesh_world_position?.('n_box') ?? null);
  for (const axis of [0, 1, 2]) {
    await expect
      .poll(async () => (await drawn())?.[axis], { timeout: 10_000 })
      .toBeCloseTo(want, 4);
  }
  const read = (await page.evaluate(
    ({ frame, seconds }) =>
      (window as unknown as W).__basher_evaluated_param?.('n_box', 'position', {
        time: { frame, seconds, normalized: 0 },
      })?.value ?? null,
    { frame, seconds: frame / FPS },
  )) as Vec3 | null;
  expect(read).not.toBeNull();
  for (const axis of [0, 1, 2]) expect(read![axis]).toBeCloseTo(want, 4);
}

test('#1549 — a Number into a Vector3 input moves the cube on all three axes', async ({ page }) => {
  await boot(page);
  await controller(page);
  await accumulator(page, 'e_a');
  await add(page, 'e_vec', 'Vec3Math', { op: 'add' });
  // The wire under test: `e_a.out` is a Number, `e_vec.a` takes a Vector3.
  await wire(page, 'e_a', 'e_vec', 'a');
  await add(page, 'e_drv', 'ParamDriver', {
    target: 'n_box',
    paramPath: 'position',
    blendMode: 'replace',
    order: 0,
  });
  await wire(page, 'e_vec', 'e_drv', 'in');

  await at(page, 0, 0.1);
  await at(page, 3, 0.4);
  await at(page, 1, 0.2);
});

test('#1590 — a Vector3 into a Number input arrives as the average of its axes', async ({
  page,
}) => {
  await boot(page);
  await controller(page);
  // Two accumulators with different starts, so the vector's axes differ: [a, b, 0].
  await accumulator(page, 'e_a');
  await add(page, 'e_make', 'MakeVec3');
  await wire(page, 'e_a', 'e_make', 'x');
  await wire(page, 'e_a', 'e_make', 'y');
  // The wire under test: `e_make.out` is a Vector3, `e_avg.a` takes a Number.
  await add(page, 'e_avg', 'Math', { op: 'add' });
  await wire(page, 'e_make', 'e_avg', 'a');
  // Back out through a Vector3 input, onto the cube: the average on all three axes.
  await add(page, 'e_vec', 'Vec3Math', { op: 'add' });
  await wire(page, 'e_avg', 'e_vec', 'a');
  await add(page, 'e_drv', 'ParamDriver', {
    target: 'n_box',
    paramPath: 'position',
    blendMode: 'replace',
    order: 0,
  });
  await wire(page, 'e_vec', 'e_drv', 'in');

  // The accumulator reads 0.1 at frame 0 and 0.4 at frame 3 (the test above). The vector is
  // [a, a, 0], so its average is two thirds of a.
  await at(page, 0, (0.1 * 2) / 3);
  await at(page, 3, (0.4 * 2) / 3);
});
