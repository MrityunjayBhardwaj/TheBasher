// Spline Wave F — the agent chat is a single text bar, no mode selector.
//
// "just say the word…" — the read-only / copilot / sandbox MODE row left the
// chat surface; the agent acts on a request in copilot (its session default).
// Falsifiable against the real DOM — reverting the change brings the selector
// or the old placeholder back (noted inline).

import { expect, test } from './_fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('basher.chrome.v1');
      localStorage.removeItem('basher.leftSidebar.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('agent-chat')).toBeVisible();
});

test('WF#1 the mode selector is gone from the chat', async ({ page }) => {
  // Revert (re-add the MODES selector) → these reappear → this fails.
  await expect(page.getByTestId('agent-mode-read-only')).toHaveCount(0);
  await expect(page.getByTestId('agent-mode-copilot')).toHaveCount(0);
  await expect(page.getByTestId('agent-mode-sandbox')).toHaveCount(0);
});

test('WF#2 the single text bar prompts "just say the word…"', async ({ page }) => {
  const input = page.getByTestId('agent-input');
  await expect(input).toBeVisible();
  // Revert the placeholder → 'ask the agent…' → this fails.
  await expect(input).toHaveAttribute('placeholder', 'just say the word…');
});

test('WF#3 the dock is bare — no "AGENT" header, no empty-state copy', async ({ page }) => {
  // Revert (re-add the header / the instructional copy) → these reappear → fails.
  await expect(page.getByTestId('agent-dock-header')).toHaveCount(0);
  await expect(page.getByText(/Ask the agent to inspect/)).toHaveCount(0);
});

test('WF#4 the send affordance is a labelled icon, not a "send" word', async ({ page }) => {
  const send = page.getByTestId('agent-send');
  await expect(send).toBeVisible();
  // Revert (text "send", no aria-label) → both assertions fail.
  await expect(send).toHaveAttribute('aria-label', 'Send');
  await expect(send).not.toContainText('send');
});

// #1704 — the chat is a full-height column now (the user's call), so the old
// "collapses to a slim bar stacked above the timeline" contract is replaced, on
// purpose, by the column's: no message list until there is a conversation, and
// the composer pinned to the column's bottom.
test('WF#5 an empty chat mounts no message list; the composer sits at the column bottom', async ({
  page,
}) => {
  await expect(page.getByTestId('agent-messages')).toHaveCount(0);
  const column = await page.getByTestId('agentdock-slot').boundingBox();
  const input = await page.getByTestId('agent-input').boundingBox();
  if (!column || !input) throw new Error('missing boxes');
  // Drop the composer's mt-auto (or let the dock stop filling the column) → the
  // composer floats up under the header → this fails.
  expect(column.y + column.height - (input.y + input.height)).toBeLessThan(24);
  expect(column.height).toBeGreaterThan(400);
});
