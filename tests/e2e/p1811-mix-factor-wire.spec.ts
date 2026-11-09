// #1811 — a Mix's factor takes a wire, and the inspector stops offering the number the wire replaced.
//
// In the running app: the Mix's own value follows the wire, the value field goes while the wire is
// on (as a linked socket's does in Blender), and comes back, still holding its setting, when the
// wire is pulled.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState(): {
      state: { outputs: { scene?: { node: string } } };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
}

test('a wired Mix factor drives the value and takes the field away', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<W>).__basher_dag?.getState().state.outputs.scene),
  );

  const mixValue = () =>
    page.evaluate(async () => {
      const w = window as unknown as W;
      const ev = await import('/src/core/dag/evaluator.ts');
      return ev.evaluate(w.__basher_dag.getState().state as never, 'e_mix').value;
    });

  await page.evaluate(async () => {
    const w = window as unknown as W;
    const d = (op: unknown) => w.__basher_dag.getState().dispatch(op, 'user', 'e2e');
    d({ type: 'addNode', nodeId: 'e_ten', nodeType: 'Fit', params: { outMin: 10, outMax: 10 } });
    d({ type: 'addNode', nodeId: 'e_q', nodeType: 'Fit', params: { outMin: 0.25, outMax: 0.25 } });
    d({ type: 'addNode', nodeId: 'e_mix', nodeType: 'Mix', params: { factor: 0.5 } });
    d({
      type: 'connect',
      from: { node: 'e_ten', socket: 'out' },
      to: { node: 'e_mix', socket: 'b' },
    });
    const sel = await import('/src/app/stores/selectionStore.ts');
    sel.useSelectionStore.getState().select('e_mix');
  });

  const field = page.getByTestId('inspector-scrub-e_mix-factor');
  const wired = page.getByTestId('inspector-wired-e_mix-factor');

  await expect(field).toBeVisible();
  await expect(wired).toHaveCount(0);
  expect(await mixValue()).toBe(5);

  const factorWire = { node: 'e_mix', socket: 'factor' };
  await page.evaluate(
    (to) =>
      (window as unknown as W).__basher_dag
        .getState()
        .dispatch({ type: 'connect', from: { node: 'e_q', socket: 'out' }, to }, 'user', 'e2e'),
    factorWire,
  );
  await expect(wired).toContainText('from e_q');
  await expect(field).toHaveCount(0);
  expect(await mixValue()).toBe(2.5);

  await page.evaluate(
    (to) =>
      (window as unknown as W).__basher_dag
        .getState()
        .dispatch({ type: 'disconnect', from: { node: 'e_q', socket: 'out' }, to }, 'user', 'e2e'),
    factorWire,
  );
  await expect(field).toBeVisible();
  await expect(wired).toHaveCount(0);
  expect(await mixValue()).toBe(5);
  expect(errors).toEqual([]);
});
