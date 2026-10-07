// #1569 — a body-input leaf's `input`, picked in the running app.
//
// A leaf that names an input its owner does not declare binds nothing and reads 0. The
// inspector shows that name as not found beside the inputs the owner does declare; a leaf in
// no sub-network shows why it has no list. Read off the real controls.

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

function shown(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const s = el as HTMLSelectElement;
    return {
      value: s.value,
      selectedText: s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : null,
      stale: s.dataset.stale ?? null,
      enabled: [...s.options].filter((o) => !o.disabled).map((o) => o.value),
      disabled: [...s.options].filter((o) => o.disabled).map((o) => o.text),
    };
  });
}

const storedInput = (page: Page, id: string) =>
  page.evaluate(
    (i) => (window as unknown as W).__basher_dag.getState().state.nodes[i].params.input,
    id,
  );

test('#1569 — a mistyped body input is shown as not found and can be re-picked', async ({
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
  await add('e_typo', 'BodyInput', { input: 'prve' });
  await add('e_good', 'BodyInput', { input: 'input' });
  await add('e_math', 'Math', { op: 'add' });
  await wire('e_typo', 'e_math', 'a');
  await wire('e_good', 'e_math', 'b');
  await add('e_solver', 'Solver');
  await wire('e_math', 'e_solver', 'body');
  await add('e_stray', 'BodyInput', { input: 'prev' });

  // The mistyped leaf: its stored name has a row, marked not found; the real inputs are
  // offered; there is no empty choice, because the param cannot be empty.
  await select(page, 'e_typo');
  const picker = 'inspector-options-e_typo-input';
  await expect(page.getByTestId(picker)).toBeVisible();
  expect(await shown(page, picker)).toEqual({
    value: 'prve',
    selectedText: 'prve — not found',
    stale: 'true',
    enabled: ['prev', 'input'],
    disabled: ['prve — not found'],
  });

  // Picking a real input writes it and clears the notice.
  await page.getByTestId(picker).selectOption('prev');
  expect(await storedInput(page, 'e_typo')).toBe('prev');
  expect(await shown(page, picker)).toEqual({
    value: 'prev',
    selectedText: 'prev',
    stale: null,
    enabled: ['prev', 'input'],
    disabled: [],
  });

  // A leaf in no sub-network: no list, its stored name and the reason.
  await select(page, 'e_stray');
  const locked = page.getByTestId('inspector-options-locked-e_stray-input');
  await expect(locked).toBeVisible();
  await expect(locked).toContainText('prev');
  await expect(locked).toContainText('not inside a sub-network, so nothing feeds it');
  await expect(page.getByTestId('inspector-options-e_stray-input')).toHaveCount(0);
});
