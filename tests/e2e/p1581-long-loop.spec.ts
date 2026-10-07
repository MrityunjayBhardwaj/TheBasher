// #1581 — a wire that closes a long loop, in the running app.
//
// `connect` used to look 32 nodes back for a loop and no further, so a wire that closed a loop
// through 40 nodes was applied and the cycle sat in the document until a read threw. It is
// refused now, in the words a short loop gets, and the graph is left as it was.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState(): {
      state: {
        nodes: Record<string, { inputs: Record<string, unknown> } | undefined>;
        outputs: { scene?: { node: string } };
      };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
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
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<W>).__basher_dag?.getState().state.outputs.scene),
  );
}

/** Build a chain of `length` Math nodes, then try the wire from the last back into the first.
 *  Returns the refusal, or null when the wire was applied. */
function closeLoop(page: Page, length: number): Promise<string | null> {
  return page.evaluate((n) => {
    const { dispatch } = (window as unknown as W).__basher_dag.getState();
    for (let i = 0; i < n; i++) {
      dispatch({ type: 'addNode', nodeId: `e_m${i}`, nodeType: 'Math', params: {} }, 'user', 'e2e');
      if (i > 0) {
        dispatch(
          {
            type: 'connect',
            from: { node: `e_m${i - 1}`, socket: 'out' },
            to: { node: `e_m${i}`, socket: 'a' },
          },
          'user',
          'e2e',
        );
      }
    }
    try {
      dispatch(
        {
          type: 'connect',
          from: { node: `e_m${n - 1}`, socket: 'out' },
          to: { node: 'e_m0', socket: 'a' },
        },
        'user',
        'e2e',
      );
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, length);
}

for (const length of [5, 40, 300]) {
  test(`a wire closing a loop through ${length} nodes is refused`, async ({ page }) => {
    await boot(page);
    expect(await closeLoop(page, length)).toBe(
      `connect: would create a cycle (e_m${length - 1} → e_m0)`,
    );
    const firstInputs = await page.evaluate(
      () => (window as unknown as W).__basher_dag.getState().state.nodes.e_m0?.inputs,
    );
    expect(firstInputs).toEqual({});
  });
}
