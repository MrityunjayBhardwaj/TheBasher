// #1574 — a body-input leaf's `slot`, in the running app's inspector.
//
// A leaf reading a list input picks one element with `slot`. Past the end of what its owner
// fills, the leaf is bound to nothing and reads its default: the inspector now says so under the
// row, and takes the note away when the slot is filled. On a single input, where `slot` does
// nothing, there is no slot row at all. Read off the real controls.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
  __basher_selection: { getState(): { select: (id: string) => void } };
}

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
    return Boolean(w.__basher_selection && w.__basher_dag);
  });
}

function dispatch(page: Page, op: unknown) {
  return page.evaluate(
    (o) => (window as unknown as W).__basher_dag.getState().dispatch(o, 'user', 'e2e'),
    op,
  );
}

const select = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as W).__basher_selection.getState().select(i), id);

const slotInput = (page: Page, id: string) => page.getByTestId(`inspector-input-${id}-slot`);
const slotNote = (page: Page, id: string) => page.getByTestId(`inspector-param-note-${id}-slot`);

test('#1574 — a slot nothing fills is said on the leaf, and a single input has no slot', async ({
  page,
}) => {
  await boot(page);
  const add = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}) =>
    dispatch(page, { type: 'addNode', nodeId, nodeType, params });
  const wire = (from: string, to: string, socket: string) =>
    dispatch(page, {
      type: 'connect',
      from: { node: from, socket: 'out' },
      to: { node: to, socket },
    });
  // A vector Solver with ONE body, so its `prevVec` has one element: slot 0.
  await add('e_p0', 'BodyInputVec', { input: 'prevVec', slot: 0 });
  await add('e_p1', 'BodyInputVec', { input: 'prevVec', slot: 1 });
  await add('e_one', 'BodyInputVec', { input: 'inputVec' });
  await add('e_mix', 'Vec3Math', { op: 'add' });
  await wire('e_p1', 'e_mix', 'a');
  await wire('e_one', 'e_mix', 'b');
  await add('e_body', 'Vec3Math', { op: 'add' });
  await wire('e_p0', 'e_body', 'a');
  await wire('e_mix', 'e_body', 'b');
  await add('e_solver', 'Solver');
  await wire('e_body', 'e_solver', 'bodies');

  // Slot 0 is filled: an ordinary row.
  await select(page, 'e_p0');
  await expect(slotInput(page, 'e_p0')).toBeVisible();
  await expect(slotNote(page, 'e_p0')).toHaveCount(0);

  // Slot 1 is past the end: the row is there, with the reason under it.
  await select(page, 'e_p1');
  await expect(slotInput(page, 'e_p1')).toBeVisible();
  await expect(slotNote(page, 'e_p1')).toHaveText(
    'nothing fills slot 1: its bodies fill slot 0 only, so this reads its default',
  );

  // A single input: `slot` does nothing, so it has no row. `input` is still there.
  await select(page, 'e_one');
  await expect(page.getByTestId('inspector-options-e_one-input')).toBeVisible();
  await expect(slotInput(page, 'e_one')).toHaveCount(0);
  await expect(slotNote(page, 'e_one')).toHaveCount(0);

  // Wire a second body: slot 1 now exists and the note goes, without reselecting.
  await select(page, 'e_p1');
  await expect(slotNote(page, 'e_p1')).toBeVisible();
  await add('e_body2', 'Vec3Math', { op: 'add' });
  await wire('e_body2', 'e_solver', 'bodies');
  await expect(slotNote(page, 'e_p1')).toHaveCount(0);
  await expect(slotInput(page, 'e_p1')).toBeVisible();
});
