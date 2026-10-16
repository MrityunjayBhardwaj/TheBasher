// #1612 — an agent turn is told in plain words: in the chat, in the review bar and as the undo step.
//
// The model is replaced by a canned reply served at the model endpoint, so the turn is the same
// every run: round 1 asks for three cubes with three `mesh.add` calls, round 2 says "Done.".
// Everything after the network — the orchestrator, the chat, the review bar, Apply — is the app's.
//
// Before the fix the bubble read `[mesh.add] {"kind":"Cube","newNodeId":"obj_…",…}` three times
// and the review bar and undo step read `mesh.add, mesh.add, mesh.add`.
//
// REF: src/agent/describeChange.ts; src/agent/orchestrator.ts; src/app/AgentChat.tsx;
//      src/app/DiffBar.tsx.

import type { Page, Route } from '@playwright/test';
import { test, expect } from './_fixtures';

const BASE = 'http://fake-llm.test/v1';

/** One server-sent-events body from a list of `choices[0].delta` objects. */
function sse(deltas: Record<string, unknown>[], finish: string): string {
  const lines = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}`);
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}`);
  lines.push('data: [DONE]');
  return lines.map((l) => `${l}\n\n`).join('');
}

const threeCubes = sse(
  [0, 1, 2].map((i) => ({
    tool_calls: [
      {
        index: i,
        id: `call_${i}`,
        type: 'function',
        function: {
          name: 'mesh.add',
          arguments: JSON.stringify({ kind: 'Cube', position: [i * 2, 0, 0] }),
        },
      },
    ],
  })),
  'tool_calls',
);
const done = sse([{ content: 'Done.' }], 'stop');
// A round the provider cut at its output cap, as a thinking model does when it spends the whole
// budget reasoning (seen live on qwen3-4b while checking this fix).
const cutOff = sse([], 'length');

async function fakeModel(page: Page, second = done): Promise<() => number> {
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
      body: calls === 1 ? threeCubes : second,
    });
  });
  return () => calls;
}

test('#1612 — three cubes from the agent read as "Added 3 cubes" in the chat, the review bar and undo', async ({
  page,
}) => {
  const calls = await fakeModel(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });

  await page.getByTestId('agent-input').fill('add three cubes in a row');
  await page.getByTestId('agent-input').press('Enter');
  await expect.poll(calls, { message: 'the turn ran both rounds' }).toBe(2);

  // The chat: one plain sentence, and nothing of the calls behind it until asked.
  const messages = page.getByTestId('agent-messages');
  await expect(page.getByTestId('agent-summary')).toHaveText('Added 3 cubes');
  const shown = await messages.innerText();
  expect(shown, 'no tool name').not.toContain('mesh.add');
  expect(shown, 'no JSON').not.toMatch(/[{}]/);
  expect(shown, 'no minted id').not.toMatch(/\b(obj|data)_[a-z0-9]{8}_[a-z0-9]{4}\b/);
  expect(shown).toContain('Done.');

  // The raw calls are one click away.
  const steps = page.getByTestId('agent-steps');
  await expect(steps).toContainText('3 steps');
  await expect(page.getByTestId('agent-step').first()).toBeHidden();
  await steps.locator('summary').click();
  await expect(page.getByTestId('agent-step')).toHaveCount(3);
  await expect(page.getByTestId('agent-step').first()).toContainText('[mesh.add]');
  await expect(page.getByTestId('agent-step').first()).toContainText('newNodeId');

  // The review bar says the same thing, with no tool names in view.
  await expect(page.getByTestId('diffbar-description')).toHaveText('Added 3 cubes');
  expect(await page.getByTestId('diffbar').innerText()).not.toContain('mesh.add');

  // Applied, the undo step carries the same name.
  await page.getByTestId('diffbar-apply').click();
  const top = await page.evaluate(() => {
    const dag = (
      window as unknown as {
        __basher_dag: { getState: () => { undoStack: { description?: string }[] } };
      }
    ).__basher_dag.getState();
    return dag.undoStack[dag.undoStack.length - 1]?.description ?? null;
  });
  expect(top).toBe('Added 3 cubes');
});

test('#1612 — when the turn stops before proposing, the bubble does not claim the cubes were added', async ({
  page,
}) => {
  const calls = await fakeModel(page, cutOff);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });

  await page.getByTestId('agent-input').fill('add three cubes in a row');
  await page.getByTestId('agent-input').press('Enter');
  await expect.poll(calls).toBe(2);
  await expect(page.getByTestId('agent-messages')).toContainText('ran out of output');

  // Nothing was proposed, so nothing may read as done.
  await expect(page.getByTestId('diffbar')).toHaveCount(0);
  await expect(page.getByTestId('agent-summary')).toHaveText(
    'Not applied, the turn stopped first: added 3 cubes',
  );
});
