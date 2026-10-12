// #1586 — an edit the graph refuses says why, on screen, in the running app.
//
// Picking an input the graph refuses used to snap the picker back and show nothing: the reason
// went to the console as an uncaught error. It is now a notice. Driven through the real
// inspector control; then through a plain DOM handler, to show the notice does not depend on
// which control dispatched; then the two cases that must stay quiet.

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

const errorToasts = (page: Page) => page.getByTestId('toast-error');

/** A Solver whose sub-network holds a Lag fed by a leaf naming an input the Solver lacks. */
async function lagInSolver(page: Page) {
  const add = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}) =>
    dispatch(page, { type: 'addNode', nodeId, nodeType, params });
  const wire = (from: string, to: string, socket: string) =>
    dispatch(page, {
      type: 'connect',
      from: { node: from, socket: 'out' },
      to: { node: to, socket },
    });
  await add('t_leaf', 'BodyInput', { input: 'prve' });
  await add('t_lag', 'Lag');
  await add('t_math', 'Math', { op: 'add' });
  await wire('t_leaf', 't_lag', 'in');
  await wire('t_lag', 't_math', 'a');
  await add('t_solver', 'Solver');
  await wire('t_math', 't_solver', 'body');
}

test('#1586 — a refused pick in the inspector says why', async ({ page }) => {
  await boot(page);
  await lagInSolver(page);
  await select(page, 't_leaf');
  const picker = page.getByTestId('inspector-options-t_leaf-input');
  await expect(picker).toBeVisible();
  await expect(errorToasts(page)).toHaveCount(0);

  await picker.selectOption('prev');

  // One notice, in the graph's words, with what to do instead; not the operation's name.
  await expect(errorToasts(page)).toHaveCount(1);
  const said = await errorToasts(page).innerText();
  expect(said).toContain('Lag "t_lag" is inside the sub-network of Solver "t_solver"');
  expect(said).toContain('Build the step into "t_solver"\'s own sub-network instead');
  expect(said).not.toContain('setParam:');
  // The edit was still refused: the stored name is the one it had.
  const stored = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.nodes['t_leaf'].params.input,
  );
  expect(stored).toBe('prve');
});

test('#1586 — a refusal from any handler is shown; a caught one and other errors are not', async ({
  page,
}) => {
  await boot(page);
  await dispatch(page, { type: 'addNode', nodeId: 'q_a', nodeType: 'Math', params: {} });
  await dispatch(page, { type: 'addNode', nodeId: 'q_b', nodeType: 'Math', params: {} });
  await dispatch(page, {
    type: 'connect',
    from: { node: 'q_a', socket: 'out' },
    to: { node: 'q_b', socket: 'a' },
  });
  // Three buttons outside React. Each click runs one handler.
  await page.evaluate(() => {
    const loop = {
      type: 'connect',
      from: { node: 'q_b', socket: 'out' },
      to: { node: 'q_a', socket: 'a' },
    };
    const send = () =>
      (window as unknown as W).__basher_dag.getState().dispatch(loop, 'user', 'e2e');
    const button = (id: string, onClick: () => void) => {
      const el = document.createElement('button');
      el.id = id;
      el.textContent = id;
      el.style.cssText = 'position:fixed;top:0;left:0;z-index:99999';
      el.addEventListener('click', onClick);
      document.body.appendChild(el);
    };
    button('q_caught', () => {
      try {
        send();
      } catch {
        // A caller that handles the refusal itself.
      }
    });
    button('q_other', () => {
      throw new TypeError('not the graph refusing anything');
    });
    button('q_uncaught', send);
  });

  await page.locator('#q_caught').dispatchEvent('click');
  await page.locator('#q_other').dispatchEvent('click');
  await page.waitForTimeout(300);
  await expect(errorToasts(page)).toHaveCount(0);

  await page.locator('#q_uncaught').dispatchEvent('click');
  await expect(errorToasts(page)).toHaveCount(1);
  await expect(errorToasts(page)).toContainText('would create a cycle (q_b → q_a)');
});
