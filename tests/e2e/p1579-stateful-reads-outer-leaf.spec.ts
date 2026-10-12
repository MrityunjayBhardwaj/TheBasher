// #1579 — a Lag inside a Solver's sub-network reading that Solver's inputs, in the running app.
//
// The wires were all accepted and the Solver then gave a plausible wrong number: the Lag is
// replayed apart from the Solver around it, where the Solver's inputs are not bound, so it read
// 0. The wire that closes that shape is refused now and says what to do instead. The same
// sub-network with the Lag reading its own controller is taken, and gives the worked numbers.

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
  __basher_evaluated_param?: (id: string, path: string, ctx?: unknown) => { value: unknown } | null;
}

const FPS = 60;

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

/** Dispatch ops in order; the index and message of the first refusal, or null. */
function attempt(page: Page, ops: unknown[]): Promise<{ at: number; said: string } | null> {
  return page.evaluate((list) => {
    const { dispatch } = (window as unknown as W).__basher_dag.getState();
    for (let i = 0; i < list.length; i++) {
      try {
        dispatch(list[i], 'user', 'e2e');
      } catch (e) {
        return { at: i, said: (e as Error).message };
      }
    }
    return null;
  }, ops);
}

const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}) => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});
const wire = (from: string, to: string, socket: string) => ({
  type: 'connect',
  from: { node: from, socket: 'out' },
  to: { node: to, socket },
});

const SOURCE = { sourceTransform: { node: 'e_ctl', channel: 'tx' } };

/** A controller held at x = 0.1, and a Solver `e_O` whose rule is `prev + e_lag`. */
async function scaffold(page: Page, lagParams: Record<string, unknown>) {
  const scene = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.outputs.scene!.node,
  );
  expect(
    await attempt(page, [
      node('e_ctl', 'Null', { position: [0.1, 0, 0] }),
      wire('e_ctl', scene, 'children'),
      node('e_prev', 'BodyInput', { input: 'prev' }),
      node('e_feed', 'BodyInput', { input: 'prev' }),
      node('e_sum', 'Math', { op: 'add' }),
      node('e_lag', 'Lag', { factor: 0.5, seedFrame: 0, ...lagParams }),
      node('e_O', 'Solver', { seedFrame: 0, ...SOURCE }),
      wire('e_prev', 'e_sum', 'a'),
      wire('e_lag', 'e_sum', 'b'),
    ]),
  ).toBeNull();
}

test('a Lag fed by the outer Solver`s prev is refused, and says what to do', async ({ page }) => {
  await boot(page);
  await scaffold(page, {});
  const refused = await attempt(page, [
    wire('e_feed', 'e_lag', 'in'),
    wire('e_sum', 'e_O', 'body'),
  ]);
  expect(refused?.at).toBe(1);
  expect(refused?.said).toBe(
    'connect: Lag "e_lag" is inside the sub-network of Solver "e_O" and would read its "prev" ' +
      'input (through "e_feed"). A Lag keeps a history of its own, replayed apart from the Solver ' +
      'around it, so it cannot see that input yet. Build the step into "e_O"\'s own sub-network ' +
      'instead (a Mix of "prev" and the input is a lag), or feed "e_lag" from outside the sub-network.',
  );
  const body = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.nodes.e_O?.inputs.body,
  );
  expect(body).toBeUndefined();
});

test('the same sub-network with the Lag on its own controller is taken and gives the worked numbers', async ({
  page,
}) => {
  await boot(page);
  await scaffold(page, SOURCE);
  expect(
    await attempt(page, [
      wire('e_sum', 'e_O', 'body'),
      node('e_drv', 'ParamDriver', {
        target: 'n_box_data',
        paramPath: 'material.base.metalness',
        blendMode: 'replace',
        order: 0,
      }),
      wire('e_O', 'e_drv', 'in'),
    ]),
  ).toBeNull();
  // The Lag trails a constant 0.1, so it is 0.1 at every frame: e_O(f) = 0.1 + 0.1·f.
  const read = await page.evaluate((fps) => {
    const w = window as unknown as W;
    return [0, 1, 2, 3].map(
      (frame) =>
        w.__basher_evaluated_param?.('n_box_data', 'material.base.metalness', {
          time: { frame, seconds: frame / fps, normalized: 0 },
        })?.value,
    );
  }, FPS);
  expect(read.map((v) => Number((v as number).toFixed(6)))).toEqual([0.1, 0.2, 0.3, 0.4]);
});
