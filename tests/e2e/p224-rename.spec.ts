// #224 — object/node RENAME. A node's user-facing label is `meta.name`
// (`nodeDisplayName` resolves meta.name ?? params.name ?? id). Before #224 it
// could only be set as an aria-label — objects were stuck showing raw ids like
// `n_box`. This wires three triggers (outliner double-click, F2, inspector
// header double-click) onto ONE `setMeta` op so render/outliner/inspector/undo
// all agree (V34 single identity).
//
// Boundary-pair: side A = the inline editor's commit (the UI surface), side B =
// `meta.name` in the live DAG (`__basher_dag`) — they must match, and the
// outliner/inspector display must reflect it.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { meta?: { name?: string } }> };
      undo: () => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
}

function metaName(page: import('@playwright/test').Page, id: string): Promise<string | undefined> {
  return page.evaluate(
    (nodeId) => (window as unknown as BasherWindow).__basher_dag.getState().state.nodes[nodeId].meta?.name,
    id,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as BasherWindow).__basher_dag &&
          (window as unknown as BasherWindow).__basher_selection,
      ),
    { timeout: 15000 },
  );
});

test('outliner double-click renames a node and undo restores it', async ({ page }) => {
  const row = page.locator('[data-testid="scene-tree-row-n_box"]');
  await expect(row).toContainText('n_box');

  await row.locator('span').first().dblclick();
  const input = page.locator('[data-testid="scene-tree-rename-n_box"]');
  await expect(input).toBeVisible();
  await input.fill('hero_cube');
  await input.press('Enter');

  // Side A (commit) == Side B (DAG meta.name)
  expect(await metaName(page, 'n_box')).toBe('hero_cube');
  // The outliner display reflects the new name.
  await expect(row).toContainText('hero_cube');

  // Undo round-trips back to unnamed (label falls back to the id).
  await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag.getState().undo());
  expect(await metaName(page, 'n_box')).toBeUndefined();
  await expect(row).toContainText('n_box');
});

test('F2 opens the outliner rename on the active node; Escape cancels with no write', async ({
  page,
}) => {
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_selection.getState().select('n_box'),
  );
  await page.keyboard.press('F2');

  const input = page.locator('[data-testid="scene-tree-rename-n_box"]');
  await expect(input).toBeVisible();
  await input.fill('discarded');
  await input.press('Escape');

  await expect(input).toBeHidden();
  expect(await metaName(page, 'n_box')).toBeUndefined();
});

test('inspector header double-click renames the selected node', async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_selection.getState().select('n_box'),
  );
  const nameEl = page.locator('[data-testid="inspector-node-name"]');
  await expect(nameEl).toBeVisible();
  await nameEl.dblclick();

  const input = page.locator('[data-testid="inspector-rename"]');
  await expect(input).toBeVisible();
  await input.fill('framed_in_inspector');
  await input.press('Enter');

  expect(await metaName(page, 'n_box')).toBe('framed_in_inspector');
  await expect(nameEl).toHaveText('framed_in_inspector');
});
