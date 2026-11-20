// #1704 — chat is one full-height column on the right; the bottom bar is playback only.
//
// Decided with the user (2026-10-20 design review, board 1 and 10): the agent's chat leaves the
// bottom-centre island for a column at the far right of the window, from under the menu bar to the
// window's bottom. The viewport, the bottom drawer and the inspector all end at its left edge. It
// folds to a slim rail with an unread dot, and ⌘L (Ctrl+L) toggles it and focuses the composer.
// Below the narrow breakpoint it is an overlay drawer, closed by default, so the viewport keeps its
// width. The model is a canned reply served at the model endpoint (the #1612 pattern), so a turn is
// the same every run.
//
// Before the fix: the chat sat inside <main> above the playback bar, so its left edge was ~324 px
// and its box ended above the timeline, never at the window bottom; ⌘L did nothing.
//
// REF: src/app/Layout.tsx; src/app/ChatColumn.tsx; src/app/stores/chatColumnStore.ts;
//      src/app/KeyboardShortcuts.tsx; src/app/layoutIslands.ts.

import type { Page, Route } from '@playwright/test';
import { test, expect } from './_fixtures';

const BASE = 'http://fake-llm.test/v1';
const REPLY = 'Hello from the column.';

function sse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    'data: [DONE]',
  ]
    .map((l) => `${l}\n\n`)
    .join('');
}

/** Serve REPLY for every model call, after `delayMs`. Returns a call counter. */
async function fakeModel(page: Page, delayMs = 0): Promise<() => number> {
  let calls = 0;
  await page.addInitScript((base) => {
    const w = window as unknown as Record<string, string>;
    w.__BASHER_LLM_KEY = 'test';
    w.__BASHER_LLM_BASE_URL = base;
    w.__BASHER_LLM_MODEL = 'fake';
  }, BASE);
  await page.route(`${BASE}/chat/completions`, async (route: Route) => {
    calls++;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse(REPLY),
    });
  });
  return () => calls;
}

async function boot(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.evaluate(() => {
    for (const k of ['basher.chrome.v1', 'basher.leftSidebar.v1', 'basher.chatColumn.v1']) {
      localStorage.removeItem(k);
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
}

type Box = { x: number; y: number; width: number; height: number };
async function box(page: Page, id: string): Promise<Box> {
  const b = await page.getByTestId(id).first().boundingBox();
  if (!b) throw new Error(`no box for ${id}`);
  return b;
}

async function expectColumnGeometry(page: Page): Promise<void> {
  const chat = await box(page, 'agentdock-slot');
  const menu = await box(page, 'menubar');
  const vp = page.viewportSize();
  if (!vp) throw new Error('no viewport size');
  // From the menu bar's bottom edge to the window's bottom, hugging the right edge.
  expect(Math.abs(chat.y - (menu.y + menu.height)), 'column top = menu bottom').toBeLessThanOrEqual(
    1,
  );
  expect(
    Math.abs(chat.y + chat.height - vp.height),
    'column bottom = window bottom',
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(chat.x + chat.width - vp.width),
    'column right = window right',
  ).toBeLessThanOrEqual(1);
  expect(chat.width, 'about 360 px wide').toBeGreaterThan(300);
  // Everything else ends at its left edge.
  for (const id of ['viewport-slot', 'view3d-slot', 'inspector-slot', 'timeline-slot']) {
    const b = await box(page, id);
    expect(b.x + b.width, `${id} ends at the column's left edge`).toBeLessThanOrEqual(chat.x + 1);
  }
}

test('#1704 C#1 the chat column spans menu bar → window bottom, everything ends at its left edge (drawer closed)', async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByTestId('timeline-slot')).toHaveAttribute('data-docked', 'false');
  await expect(page.getByTestId('agentdock-slot').getByTestId('agent-chat')).toBeVisible();
  await expectColumnGeometry(page);
});

test('#1704 C#2 the same with the drawer open — the drawer ends at the column too', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-slot')).toHaveAttribute('data-docked', 'true');
  await expectColumnGeometry(page);
});

test('#1704 C#3 the bottom bar holds only playback — no chat inside the viewport, in 3D and 2D', async ({
  page,
}) => {
  await boot(page);
  for (const space of ['view3d', 'uv'] as const) {
    if (space === 'uv') await page.getByTestId('space-switch-uv').click();
    await expect(page.getByTestId('layout')).toHaveAttribute('data-space', space);
    await expect(page.getByTestId('viewport-slot').getByTestId('agent-chat')).toHaveCount(0);
    await expect(page.getByTestId('viewport-slot').getByTestId('agent-input')).toHaveCount(0);
    // The chat is still on screen — in the column.
    await expect(page.getByTestId('agentdock-slot').getByTestId('agent-input')).toBeVisible();
  }
});

test('#1704 C#4 ⌘L folds and reopens the column: same history, composer focused, Canvas not remounted', async ({
  page,
}) => {
  const calls = await fakeModel(page);
  await boot(page);
  await page.getByTestId('agent-input').fill('hello');
  await page.getByTestId('agent-input').press('Enter');
  await expect.poll(calls).toBe(1);
  await expect(page.getByTestId('agent-messages')).toContainText(REPLY);
  const before = await page.getByTestId('agent-messages').innerText();

  // Tag the one Canvas so a remount (a new element) is visible.
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid="view3d-slot"] canvas');
    if (!c) throw new Error('no canvas');
    (c as HTMLCanvasElement).dataset.p1704 = 'same';
  });
  const mainBefore = await box(page, 'viewport-slot');

  await page.locator('body').click({ position: { x: 700, y: 50 } });
  await page.keyboard.press('Meta+l');
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('chat-rail')).toBeVisible();
  const rail = await box(page, 'agentdock-slot');
  expect(rail.width, 'closed = a slim rail').toBeLessThanOrEqual(44);
  // The viewport grew into the freed width (a resize, not a remount).
  await expect
    .poll(async () => (await box(page, 'viewport-slot')).width)
    .toBeGreaterThan(mainBefore.width + 250);

  await page.keyboard.press('Control+l');
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('agent-input')).toBeFocused();
  expect(await page.getByTestId('agent-messages').innerText()).toBe(before);
  const sameCanvas = await page.evaluate(() => {
    const all = document.querySelectorAll('canvas[data-p1704="same"]');
    const first = document.querySelector('[data-testid="view3d-slot"] canvas');
    return all.length === 1 && first?.getAttribute('data-p1704') === 'same';
  });
  expect(sameCanvas, 'the Canvas element survived both toggles').toBe(true);
  expect(calls(), 'toggling sends nothing').toBe(1);
});

test('#1704 C#5 a reply that lands while the column is folded lights the rail’s unread dot', async ({
  page,
}) => {
  const calls = await fakeModel(page, 1500);
  await boot(page);
  await page.getByTestId('agent-input').fill('hello');
  await page.getByTestId('agent-input').press('Enter');
  await expect.poll(calls).toBe(1);
  await page.keyboard.press('Meta+l');
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('chat-unread-dot')).toBeVisible({ timeout: 10_000 });
  // Opening reads it.
  await page.getByTestId('chat-rail').click();
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('agent-messages')).toContainText(REPLY);
  await page.keyboard.press('Meta+l');
  await expect(page.getByTestId('chat-unread-dot')).toHaveCount(0);
});

test('#1704 C#6 ⌘L typed into another field toggles chat without typing into the field', async ({
  page,
}) => {
  await boot(page);
  const search = page.getByPlaceholder('Search objects…');
  await search.click();
  await search.pressSequentially('cu');
  await page.keyboard.press('Meta+l');
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'false');
  await expect(search).toHaveValue('cu');
  // A bare `l` in a field is just a letter.
  await search.click();
  await page.keyboard.press('l');
  await expect(search).toHaveValue('cul');
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'false');
});

test('#1704 C#7 the chat is in the video space too, and gone in present mode', async ({ page }) => {
  await boot(page);
  await page.getByTestId('space-switch-video').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-space', 'video');
  await expect(page.getByTestId('agentdock-slot').getByTestId('agent-input')).toBeVisible();
  const chat = await box(page, 'agentdock-slot');
  const video = await box(page, 'video-slot');
  expect(video.x + video.width).toBeLessThanOrEqual(chat.x + 1);

  await page.getByTestId('space-switch-view3d').click();
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('agentdock-slot')).toBeHidden();
  await expect(page.getByTestId('chat-rail')).toBeHidden();
  const main = await box(page, 'viewport-slot');
  expect(main.width, 'present gives the column back to the picture').toBeGreaterThan(1440 - 2);
});

test.describe('narrow (<1024 px)', () => {
  test('#1704 C#8 the chat is an overlay drawer, closed by default; the viewport keeps its width', async ({
    page,
  }) => {
    await boot(page, 900, 820);
    const layout = await box(page, 'layout');
    await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'false');
    await expect(page.getByTestId('agent-input')).toBeHidden();
    expect((await box(page, 'viewport-slot')).width).toBeGreaterThan(layout.width - 2);

    await page.keyboard.press('Meta+l');
    await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('agent-input')).toBeFocused();
    // Overlays the viewport rather than taking width from it.
    expect((await box(page, 'viewport-slot')).width).toBeGreaterThan(layout.width - 2);
    const chat = await box(page, 'agentdock-slot');
    expect(Math.abs(chat.x + chat.width - 900)).toBeLessThanOrEqual(1);
    expect(chat.width).toBeGreaterThan(300);
  });
});

test('#1704 C#9 the side panels reclaim the old chat band: outliner runs to the bottom, inspector still clears the gizmo', async ({
  page,
}) => {
  await boot(page);
  for (const open of [false, true]) {
    if (open) await page.getByTestId('timeline-drawer-toggle').click();
    await expect(page.getByTestId('timeline-slot')).toHaveAttribute('data-docked', String(open));
    const main = await box(page, 'viewport-slot');
    const tree = await box(page, 'tree-slot');
    const insp = await box(page, 'inspector-slot');
    const mainBottom = main.y + main.height;
    // The outliner runs down to the island gap (the old 140 px band held the chat).
    expect(
      mainBottom - (tree.y + tree.height),
      `outliner bottom gap (drawer open=${open})`,
    ).toBeLessThanOrEqual(13);
    // The inspector still stops above the orbit gizmo (centre 80 px from the corner, ~45 px radius)
    // and the Persp/Ortho pill.
    const pill = await box(page, 'projection-toggle');
    expect(insp.y + insp.height, 'inspector above the pill').toBeLessThan(pill.y);
    expect(mainBottom - (insp.y + insp.height), 'inspector above the gizmo').toBeGreaterThanOrEqual(
      128,
    );
    if (!open) {
      // The playback bar sits between the islands, never under the outliner.
      const bar = await box(page, 'timeline-slot');
      expect(tree.x + tree.width).toBeLessThan(bar.x);
    }
  }
});
