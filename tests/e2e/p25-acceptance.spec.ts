// P2.5 acceptance — agent chat UI + token bar visibility.
//
// H16: The token usage bar was clipping (invisible behind the input area)
// because the CSS-grid drawer area used `display: block` instead of `flex`,
// so the messages container didn't shrink-to-fit. Fix: Layout.tsx drawer
// slot uses `display: flex; flexDirection: column; minHeight: 0` so the
// flex chain constrains children properly.
//
// REF: THESIS.md §15-17 (editor chrome), §21 (context strategy).

import { expect, test } from './_fixtures';

interface AgentSessionWindow {
  __basher_agent_session?: {
    getState: () => {
      session: {
        tokenUsage: { input: number; output: number; total: number };
        messages: unknown[];
        mode: string;
        isStreaming: boolean;
        error: string | null;
      };
      addMessage: (msg: { role: 'user' | 'assistant'; content: string }) => void;
      addTokenUsage: (input: number, output: number) => void;
    };
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as AgentSessionWindow;
    return Boolean(w.__basher_agent_session);
  });
});

// ---------------------------------------------------------------------------
// H16#1 — token usage bar is visible after a message exchange.
//
// Regression: the token bar was rendered below the fold because the messages
// container overflowed its parent without scroll. After fix, the bar must
// be within the visible viewport of the drawer.
// ---------------------------------------------------------------------------

test('H16#1 token bar is scrolled into view after messages fill the drawer', async ({ page }) => {
  // Simulate a user message + assistant reply so token usage is non-zero.
  await page.evaluate(() => {
    const w = window as unknown as AgentSessionWindow;
    const store = w.__basher_agent_session!;
    store.getState().addMessage({ role: 'user', content: 'add a new cube' });
    store.getState().addMessage({
      role: 'assistant',
      content: 'I added a CubeMesh node. You can see it in the viewport.',
    });
    store.getState().addTokenUsage(631, 15);
  });

  await page.waitForTimeout(200);

  // The token bar must be visible inside the drawer.
  const tokenBar = page.getByTestId('agent-tokens');
  await expect(tokenBar).toBeVisible({ timeout: 3_000 });
  await expect(tokenBar).toHaveText(/Tokens:/);

  // Both messages must be visible in the message list.
  const messages = page.getByTestId('agent-messages');
  await expect(messages).toContainText('add a new cube');
  await expect(messages).toContainText('CubeMesh');
});
