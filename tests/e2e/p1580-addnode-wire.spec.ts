// #1580 — a wire that comes in on `addNode`, in the running app.
//
// `connect` refused a pose wired into a Number input; the same wire handed to `addNode` in its
// `inputs` was applied, and the graph then held a wire no reader could make sense of. Both
// doors now refuse it in the same words and nothing is added. A wire the socket does take,
// or one that converts, still comes in on `addNode`.

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

/** Dispatch one op; the refusal's message, or null when it was applied. */
function attempt(page: Page, op: unknown): Promise<string | null> {
  return page.evaluate((o) => {
    try {
      (window as unknown as W).__basher_dag.getState().dispatch(o, 'user', 'e2e');
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, op);
}

const has = (page: Page, id: string) =>
  page.evaluate(
    (nodeId) => Boolean((window as unknown as W).__basher_dag.getState().state.nodes[nodeId]),
    id,
  );

/** A refusal without the name of the operation that raised it. */
const body = (message: string | null) => (message ?? '').replace(/^(addNode|connect): /, '');

test('a wire the socket does not take is refused on addNode as it is on connect', async ({
  page,
}) => {
  await boot(page);
  expect(
    await attempt(page, { type: 'addNode', nodeId: 'e_sk', nodeType: 'Skeleton', params: {} }),
  ).toBeNull();
  const pose = { node: 'e_sk', socket: 'pose' };

  // Through addNode: refused, and the node is not in the graph.
  const viaAdd = await attempt(page, {
    type: 'addNode',
    nodeId: 'e_bad',
    nodeType: 'Math',
    params: {},
    inputs: { a: pose },
  });
  expect(viaAdd).toMatch(/^addNode: type mismatch Skeleton\.pose:PosedSkeleton → Math\.a:Number/);
  expect(await has(page, 'e_bad')).toBe(false);

  // Through connect, onto a node added bare: the same words.
  expect(
    await attempt(page, { type: 'addNode', nodeId: 'e_m', nodeType: 'Math', params: {} }),
  ).toBeNull();
  const viaConnect = await attempt(page, {
    type: 'connect',
    from: pose,
    to: { node: 'e_m', socket: 'a' },
  });
  expect(viaConnect).toMatch(/^connect: type mismatch/);
  expect(body(viaAdd)).toBe(body(viaConnect));

  // A producer that is not there, and a socket the type does not have.
  expect(
    await attempt(page, {
      type: 'addNode',
      nodeId: 'e_ghost',
      nodeType: 'Math',
      params: {},
      inputs: { a: { node: 'nobody', socket: 'out' } },
    }),
  ).toBe('Node not found: nobody');
  expect(
    await attempt(page, {
      type: 'addNode',
      nodeId: 'e_sock',
      nodeType: 'Math',
      params: {},
      inputs: { nope: { node: 'e_m', socket: 'out' } },
    }),
  ).toBe("addNode: Math has no input socket 'nope'");
  expect(await has(page, 'e_ghost')).toBe(false);
  expect(await has(page, 'e_sock')).toBe(false);
});

test('a wire the socket takes still comes in on addNode', async ({ page }) => {
  await boot(page);
  expect(
    await attempt(page, { type: 'addNode', nodeId: 'e_m', nodeType: 'Math', params: {} }),
  ).toBeNull();
  // A Number into a Number, and a Number into a Vector3 (it converts, #1549).
  expect(
    await attempt(page, {
      type: 'addNode',
      nodeId: 'e_sum',
      nodeType: 'Math',
      params: {},
      inputs: { a: { node: 'e_m', socket: 'out' } },
    }),
  ).toBeNull();
  expect(
    await attempt(page, {
      type: 'addNode',
      nodeId: 'e_brk',
      nodeType: 'VecBreak3',
      params: {},
      inputs: { v: { node: 'e_m', socket: 'out' } },
    }),
  ).toBeNull();
  const stored = await page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return { sum: nodes.e_sum?.inputs, brk: nodes.e_brk?.inputs };
  });
  expect(stored.sum).toEqual({ a: { node: 'e_m', socket: 'out' } });
  expect(stored.brk).toEqual({ v: { node: 'e_m', socket: 'out' } });
});
