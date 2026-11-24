// #1705 — the composer says which pane and moment you mean: chips for the selection (What), the
// last pane you worked in (Where) and the playhead (When), and each one reaches the model as a
// line of the turn's context unless you dismiss it.
//
// The model is a canned "Done." at the model endpoint (the #1612 / #1706 pattern) and every request
// body is captured, so the assertions read the very text the provider would be handed. Everything
// before the network — the pane tracking, the chips, the orchestrator — is the app's.
//
// REF: src/app/agent/ContextChips.tsx; src/app/stores/agentContextStore.ts;
//      src/agent/orchestrator.ts (buildContextBlock).

import type { Page, Route } from '@playwright/test';
import { test, expect } from './_fixtures';
import { openDrawerTab } from './_drawer';

const BASE = 'http://fake-llm.test/v1';

const DONE = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
  'data: [DONE]',
]
  .map((l) => `${l}\n\n`)
  .join('');

interface Body {
  messages: { role: string; content: string }[];
}

/** Serve "Done." to every call; returns the captured request bodies (live array). */
async function fakeModel(page: Page): Promise<Body[]> {
  const bodies: Body[] = [];
  await page.addInitScript((base) => {
    const w = window as unknown as Record<string, string>;
    w.__BASHER_LLM_KEY = 'test';
    w.__BASHER_LLM_BASE_URL = base;
    w.__BASHER_LLM_MODEL = 'fake';
  }, BASE);
  await page.route(`${BASE}/chat/completions`, (route: Route) => {
    bodies.push(route.request().postDataJSON() as Body);
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: DONE,
    });
  });
  return bodies;
}

interface Win {
  __basher_dag?: unknown;
  __basher_selection: { getState(): { select(id: string | null): void } };
  __basher_time: { getState(): { setTime(s: number): void } };
}

/** The user message of a request: the Context block + the request. */
const userText = (b: Body) => b.messages[b.messages.length - 1].content;
const withoutChipLines = (s: string) => s.replace(/^(Where|When): .*$/gm, '');

async function send(page: Page, bodies: Body[], text: string): Promise<string> {
  const before = bodies.length;
  await page.getByTestId('agent-input').fill(text);
  await page.getByTestId('agent-input').press('Enter');
  await expect
    .poll(() => bodies.length, { message: 'the turn reached the model' })
    .toBe(before + 1);
  await expect(page.getByTestId('agent-input')).toBeEnabled();
  return userText(bodies[before]);
}

async function boot(page: Page): Promise<Body[]> {
  const bodies = await fakeModel(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as Partial<Win>).__basher_dag));
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__basher_selection.getState().select('n_box');
    w.__basher_time.getState().setTime(1.5);
  });
  return bodies;
}

test('#1705 — the same sentence from Curves and from Nodes reaches the model with a different Where, and nothing else differs', async ({
  page,
}) => {
  const bodies = await boot(page);
  const where = page.getByTestId('context-chip-where');

  await openDrawerTab(page, 'curve');
  await page.getByTestId('curve-editor-pane').click({ position: { x: 40, y: 40 } });
  await expect(where).toContainText('Curves');

  // Typing in the chat is not "working in a pane": Where still names Curves.
  await page.getByTestId('agent-input').click();
  await page.getByTestId('agent-input').type('make it');
  await expect(where).toContainText('Curves');

  const fromCurves = await send(page, bodies, 'make it rougher');
  expect(fromCurves).toMatch(/^Where: Curves/m);

  await openDrawerTab(page, 'nodes');
  // The node view's header, not its canvas: a click on the canvas would clear the selection, and
  // the two requests are meant to differ in Where alone.
  await page.getByTestId('graph-view-counts').click();
  await expect(where).toContainText('Nodes');
  const fromNodes = await send(page, bodies, 'make it rougher');
  expect(fromNodes).toMatch(/^Where: Nodes/m);

  expect(fromNodes).not.toBe(fromCurves);
  expect(withoutChipLines(fromNodes)).toBe(withoutChipLines(fromCurves));
});

test('#1705 — the chips show What, Where and When; ✕ on When leaves it out of the next message only; the playhead moves the When chip', async ({
  page,
}) => {
  const bodies = await boot(page);

  await expect(page.getByTestId('context-chip-what')).toContainText(/box/i);
  await expect(page.getByTestId('context-chip-when')).toContainText('1.50 s');
  await expect(page.getByTestId('agent-input')).toHaveAttribute(
    'placeholder',
    /^Ask or tell Basher… \((⌘L|Ctrl\+L)\)$/,
  );

  const first = await send(page, bodies, 'make it rougher');
  expect(first).toMatch(/^When: .*1\.50 s/m);
  expect(first).toMatch(/^Selected nodes:\n {2}- n_box/m);

  await page.getByTestId('context-chip-when-dismiss').click();
  await expect(page.getByTestId('context-chip-when')).toHaveCount(0);
  const dismissed = await send(page, bodies, 'make it rougher');
  expect(dismissed).not.toMatch(/^When:/m);
  expect(dismissed).toMatch(/^Selected nodes:/m);

  // Dismissal lasts one message: the chip is back, and so is the line.
  await expect(page.getByTestId('context-chip-when')).toBeVisible();
  const after = await send(page, bodies, 'make it rougher');
  expect(after).toMatch(/^When: /m);

  // Dismissing What drops the selection from the next message.
  await page.getByTestId('context-chip-what-dismiss').click();
  const noWhat = await send(page, bodies, 'make it rougher');
  expect(noWhat).not.toMatch(/Selected nodes/);

  // The chip reads the live playhead.
  await page.evaluate(() => (window as unknown as Win).__basher_time.getState().setTime(3.4));
  await expect(page.getByTestId('context-chip-when')).toContainText('3.40 s');
});

test('#1705 — @ adds an object and a shot as chips; both reach the model and are gone after the message', async ({
  page,
}) => {
  const bodies = await boot(page);

  await page.getByTestId('context-add').click();
  const picker = page.getByTestId('context-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('context-pick-object-n_camera').click();
  await expect(picker).toHaveCount(0);
  await page.getByTestId('context-add').click();
  await picker.getByTestId('context-pick-shot-0').click();

  const extras = page.getByTestId('context-chip-extra');
  await expect(extras).toHaveCount(2);
  await expect(extras.nth(0)).toContainText('n_camera');
  await expect(extras.nth(1)).toContainText('Shot 1');

  const sent = await send(page, bodies, 'frame it from here');
  expect(sent).toMatch(/^Also: .*n_camera.*; Shot 1 \(0\.00–\d+\.\d\d s\)/m);

  // Like the other chips, an added ref is for one message.
  await expect(extras).toHaveCount(0);
  const next = await send(page, bodies, 'frame it from here');
  expect(next).not.toMatch(/^Also:/m);
});

test('#1705 — typing @ at the start of a word opens the picker; Escape closes it and adds nothing', async ({
  page,
}) => {
  await boot(page);
  const input = page.getByTestId('agent-input');
  await input.click();
  await input.type('look at ');
  await expect(page.getByTestId('context-picker')).toHaveCount(0);
  await input.type('@');
  await expect(page.getByTestId('context-picker')).toBeVisible();
  await input.press('Escape');
  await expect(page.getByTestId('context-picker')).toHaveCount(0);
  await expect(page.getByTestId('context-chip-extra')).toHaveCount(0);
  await expect(input).toHaveValue('look at @');

  // Mid-word "@" (an address) is just text.
  await input.fill('');
  await input.type('me@');
  await expect(page.getByTestId('context-picker')).toHaveCount(0);

  // Picking from a typed @ takes the @ out of the message and adds the chip.
  await input.fill('');
  await input.type('look at @');
  await page.getByTestId('context-pick-pane-nodes').click();
  await expect(page.getByTestId('context-chip-extra')).toContainText('Nodes');
  await expect(input).toHaveValue('look at ');
});
