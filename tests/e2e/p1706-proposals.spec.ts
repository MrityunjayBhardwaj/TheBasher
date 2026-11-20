// #1706 — an agent proposal lands where it takes effect: a change list in chat, a mark in each
// editor it touches, and one Accept = one undo step, from every space.
//
// The model is a canned reply at the model endpoint (the #1612 pattern): round 1 calls `dag.exec`
// with two ops, a setParam on the cube and an addNode of an empty; round 2 says "Done.". Everything
// after the network — the orchestrator, the diff, the chat, the marks, Accept — is the app's.
//
// Before #1706 the only accept surface (the DiffBar) was mounted INSIDE the 3D slot, so in the 2D
// view (display:none on that slot) a pending proposal could be neither seen nor accepted.
//
// REF: src/app/ProposalCard.tsx; src/agent/diff/proposalLines.ts; src/agent/diff/store.ts.

import type { Page, Route } from '@playwright/test';
import { test, expect } from './_fixtures';

const BASE = 'http://fake-llm.test/v1';

function sse(deltas: Record<string, unknown>[], finish: string): string {
  const lines = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}`);
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}`);
  lines.push('data: [DONE]');
  return lines.map((l) => `${l}\n\n`).join('');
}

const OPS = [
  { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [2, 0, 0] },
  { type: 'addNode', nodeId: 'p1706_null', nodeType: 'Null', params: {} },
];

const propose = sse(
  [
    {
      tool_calls: [
        {
          index: 0,
          id: 'call_0',
          type: 'function',
          function: {
            name: 'dag.exec',
            arguments: JSON.stringify({ description: 'move the cube, add an empty', ops: OPS }),
          },
        },
      ],
    },
  ],
  'tool_calls',
);
const done = sse([{ content: 'Done.' }], 'stop');

/** Serve the canned turn; returns a counter of model calls. */
async function fakeModel(page: Page): Promise<() => number> {
  let calls = 0;
  await page.addInitScript((base) => {
    const w = window as unknown as Record<string, string>;
    w.__BASHER_LLM_KEY = 'test';
    w.__BASHER_LLM_BASE_URL = base;
    w.__BASHER_LLM_MODEL = 'fake';
  }, BASE);
  await page.route(`${BASE}/chat/completions`, (route: Route) => {
    calls++;
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: calls % 2 === 1 ? propose : done,
    });
  });
  return () => calls;
}

interface DagWin {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { params: Record<string, unknown> }>; outputs: unknown };
      undoStack: unknown[];
    };
  };
}

/** The whole scene as data — what "exactly the prior state" is compared on. */
async function dagJson(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const s = (window as unknown as DagWin).__basher_dag.getState().state;
    return JSON.parse(JSON.stringify({ nodes: s.nodes, outputs: s.outputs }));
  });
}

async function boxPosition(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      (window as unknown as DagWin).__basher_dag.getState().state.nodes['n_box']?.params.position,
  );
}

async function hasNull(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Boolean((window as unknown as DagWin).__basher_dag.getState().state.nodes['p1706_null']),
  );
}

/** Boot, run the canned turn, and wait for the proposal. Returns the scene before it. */
async function runTurn(page: Page): Promise<unknown> {
  const calls = await fakeModel(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as Partial<DagWin>).__basher_dag));
  const before = await dagJson(page);
  await page.getByTestId('agent-input').fill('move the cube over and add an empty');
  await page.getByTestId('agent-input').press('Enter');
  await expect.poll(calls, { message: 'the turn ran both rounds' }).toBe(2);
  await expect(page.getByTestId('proposal-card')).toBeVisible();
  return before;
}

test('#1706 — the proposal is listed in chat, marked in the viewport, and accepted from 2D as one undo step', async ({
  page,
}) => {
  const before = await runTurn(page);

  // The chat lists one line per change, the value edit with its old and new value.
  const lines = page.getByTestId('proposal-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText('position');
  await expect(lines.nth(0).getByTestId('proposal-line-before')).toHaveText('0, 0, 0');
  await expect(lines.nth(0).getByTestId('proposal-line-after')).toHaveText('2, 0, 0');
  await expect(lines.nth(1)).toContainText('Added an empty');

  // The viewport says a proposal is being previewed, not applied.
  await expect(page.getByTestId('proposal-viewport-edge')).toBeVisible();
  expect(await boxPosition(page), 'nothing applied yet').toEqual([0, 0, 0]);

  // In the 2D view the 3D slot is hidden — the proposal is still listed and Accept still works.
  await page.getByTestId('space-switch-uv').click();
  await expect(page.getByTestId('view3d-slot')).toBeHidden();
  await expect(page.getByTestId('proposal-viewport-edge')).toBeHidden();
  const undoDepth = await page.evaluate(
    () => (window as unknown as DagWin).__basher_dag.getState().undoStack.length,
  );
  await page.getByTestId('proposal-accept').click();
  await expect(page.getByTestId('proposal-card')).toHaveCount(0);
  expect(await boxPosition(page)).toEqual([2, 0, 0]);
  expect(await hasNull(page)).toBe(true);
  expect(
    await page.evaluate(
      () => (window as unknown as DagWin).__basher_dag.getState().undoStack.length,
    ),
    'Accept is ONE undo step',
  ).toBe(undoDepth + 1);

  // One ⌘Z restores exactly the scene before the proposal.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => dagJson(page)).toEqual(before);
});

test('#1706 — Reject leaves the scene untouched', async ({ page }) => {
  const before = await runTurn(page);
  await page.getByTestId('proposal-reject').click();
  await expect(page.getByTestId('proposal-card')).toHaveCount(0);
  await expect(page.getByTestId('proposal-viewport-edge')).toHaveCount(0);
  expect(await dagJson(page)).toEqual(before);
});

test('#1706 — unticking one line, Accept applies only the other', async ({ page }) => {
  await runTurn(page);
  const first = page.getByTestId('proposal-line').nth(0);
  await first.getByTestId('proposal-line-check').uncheck();
  await expect(first.getByTestId('proposal-line-check')).not.toBeChecked();
  await expect(page.getByTestId('proposal-accept')).toContainText('1');
  await page.getByTestId('proposal-accept').click();
  await expect(page.getByTestId('proposal-card')).toHaveCount(0);
  expect(await boxPosition(page), 'the unticked setParam did not land').toEqual([0, 0, 0]);
  expect(await hasNull(page), 'the ticked addNode did').toBe(true);
});

test('#1706 — the editors mark it: the inspector row reads old → new, Nodes outlines and its tab counts', async ({
  page,
}) => {
  await runTurn(page);

  // Clicking the value line goes to it: the cube is selected and its inspector row shows old → new.
  await page.getByTestId('proposal-line').nth(0).getByTestId('proposal-line-go').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __basher_selection?: { getState(): { primaryNodeId: string | null } };
            }
          ).__basher_selection?.getState().primaryNodeId,
      ),
    )
    .toBe('n_box');
  const mark = page.getByTestId('inspector-proposed');
  await expect(mark).toBeVisible();
  await expect(mark).toContainText('0, 0, 0');
  await expect(mark).toContainText('2, 0, 0');

  // The drawer's Nodes tab counts both changes; clicking the add line opens it there, outlined.
  await page.getByTestId('proposal-line').nth(1).getByTestId('proposal-line-go').click();
  await expect(page.getByTestId('timeline-tab-nodes')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('timeline-tab-nodes-proposed')).toHaveText('2');
  await expect(page.locator('[data-graph-node="p1706_null"][data-proposed]')).toHaveCount(1);
  await expect(page.locator('[data-graph-node="n_box"][data-proposed]')).toHaveCount(1);
});

test('#1706 — a proposal that arrives while the chat is folded opens it; folded again, the rail says one waits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as Partial<DagWin>).__basher_dag));
  await page.getByTestId('chat-column-close').click();
  await expect(page.getByTestId('chat-rail')).toBeVisible();

  // Any proposer lands in the same place: here the store is called directly, as the orchestrator
  // does at the end of a turn.
  await page.evaluate((ops) => {
    const w = window as unknown as {
      __basher_dag: { getState(): { state: unknown } };
      __basher_diff: {
        getState(): { propose(s: unknown, ops: unknown[], d: string): unknown };
      };
    };
    w.__basher_diff.getState().propose(w.__basher_dag.getState().state, ops, 'move the cube');
  }, OPS);
  await expect(page.getByTestId('proposal-card')).toBeVisible();

  // Folded again while it waits: it stays folded, and the rail carries the cue.
  await page.getByTestId('chat-column-close').click();
  await expect(page.getByTestId('proposal-card')).toBeHidden();
  await expect(page.getByTestId('chat-proposal-cue')).toBeVisible();
  await expect(page.getByTestId('chat-rail')).toHaveAttribute('aria-label', /proposal/);
});

test('#1706 — a proposed keyframe change is marked in the Dopesheet and Curves, each tab counting it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as Partial<DagWin>).__basher_dag));
  const keys = [
    { time: 0, value: [0, 0, 0], easing: 'linear' },
    { time: 1, value: [1, 0, 0], easing: 'linear' },
  ];
  await page.evaluate((keys) => {
    const w = window as unknown as {
      __basher_dag: {
        getState(): {
          state: unknown;
          dispatchAtomic(ops: unknown[], source: string, d: string): unknown;
        };
      };
      __basher_diff: { getState(): { propose(s: unknown, ops: unknown[], d: string): unknown } };
    };
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1706_ch',
          nodeType: 'KeyframeChannelVec3',
          params: { target: 'n_box', paramPath: 'position', keyframes: keys },
        },
      ],
      'user',
      'key the cube',
    );
    w.__basher_diff.getState().propose(
      w.__basher_dag.getState().state,
      [
        {
          type: 'setParam',
          nodeId: 'p1706_ch',
          paramPath: 'keyframes',
          value: [...keys, { time: 2, value: [3, 0, 0], easing: 'linear' }],
        },
      ],
      'add a key',
    );
  }, keys);

  const line = page.getByTestId('proposal-line');
  await expect(line).toHaveCount(1);
  await expect(line.getByTestId('proposal-line-before')).toHaveText('2 items');
  await expect(line.getByTestId('proposal-line-after')).toHaveText('3 items');

  // Clicking it opens Curves on that channel, framed; both key tabs count it.
  await line.getByTestId('proposal-line-go').click();
  await expect(page.getByTestId('timeline-tab-curve')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('curve-editor-proposed')).toBeVisible();
  await expect(page.getByTestId('timeline-tab-curve-proposed')).toHaveText('1');
  await expect(page.getByTestId('timeline-tab-dopesheet-proposed')).toHaveText('1');

  await page.getByTestId('timeline-tab-dopesheet').click();
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-proposed-rows', '1');

  // Rejected, every mark goes.
  await page.getByTestId('proposal-reject').click();
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-proposed-rows', '0');
  await expect(page.getByTestId('timeline-tab-dopesheet-proposed')).toHaveCount(0);
});

test('#1706 — going to a line in the inspector at 1440 px unfolds it and keeps the card open', async ({
  page,
}) => {
  await runTurn(page);
  // Fold the inspector, as the #1704 rule would have when the chat opened.
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_chrome: { getState(): { setInspectorCollapsed: (v: boolean) => void } };
    };
    w.__basher_chrome.getState().setInspectorCollapsed(true);
  });
  await expect(page.getByTestId('inspector-proposed')).toHaveCount(0);

  // Navigation from the card is not the user unfolding the inspector: chat stays open.
  await page.getByTestId('proposal-line').nth(0).getByTestId('proposal-line-go').click();
  const mark = page.getByTestId('inspector-proposed');
  await expect(mark).toBeVisible();
  await expect(mark).toContainText('0, 0, 0');
  await expect(mark).toContainText('2, 0, 0');
  await expect(page.getByTestId('proposal-card')).toBeVisible();
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'true');
});
