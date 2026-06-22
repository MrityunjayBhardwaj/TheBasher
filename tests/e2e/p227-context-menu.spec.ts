// #227 Slice 2 — outliner right-click context menu. Rename / Select Hierarchy /
// Delete, acting on the right-clicked node (the whole multi-set when it's part of
// one). Rename is single-node only (disabled for a multi-set). Esc closes the menu
// WITHOUT clearing the selection (capture-phase preempts the global Escape). Delete
// reuses the SAME op-builder as the Delete key (one authority).

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface CtxWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }>; nodes: Record<string, unknown> };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { selectedNodeIds: ReadonlySet<string>; primaryNodeId: string | null };
  };
}

const row = (page: Page, id: string) => page.locator(`[data-testid="scene-tree-row-${id}"]`);
const menu = (page: Page) => page.locator('[data-testid="outliner-context-menu"]');
const nodeExists = (page: Page, id: string) =>
  page.evaluate((n) => Boolean((window as unknown as CtxWindow).__basher_dag.getState().state.nodes[n]), id);
const selection = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as CtxWindow).__basher_selection.getState();
    return { ids: [...s.selectedNodeIds].sort(), primary: s.primaryNodeId };
  });

async function addGroupWithChild(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as CtxWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'n_grp', nodeType: 'Group', params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] } },
        { type: 'addNode', nodeId: 'n_child', nodeType: 'BoxMesh', params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { type: 'connect', from: { node: 'n_grp', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'connect', from: { node: 'n_child', socket: 'out' }, to: { node: 'n_grp', socket: 'children' } },
      ],
      'user',
      'group',
    );
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as CtxWindow).__basher_dag), { timeout: 15000 });
});

test('right-click opens the menu and selects the row; Esc closes it without clearing', async ({ page }) => {
  await row(page, 'n_box').click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  expect((await selection(page)).primary).toBe('n_box');

  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  // Selection survives — the menu's capture-phase Esc preempts the global clear.
  expect((await selection(page)).ids).toEqual(['n_box']);
});

test('Delete removes the node (same op-builder as the Delete key)', async ({ page }) => {
  await row(page, 'n_box').click({ button: 'right' });
  await page.locator('[data-testid="outliner-ctx-delete"]').click();
  await expect(menu(page)).toHaveCount(0);
  expect(await nodeExists(page, 'n_box')).toBe(false);
});

test('Select Hierarchy selects the node and all its descendants', async ({ page }) => {
  await addGroupWithChild(page);
  await row(page, 'n_grp').click({ button: 'right' });
  await page.locator('[data-testid="outliner-ctx-select-hierarchy"]').click();
  expect((await selection(page)).ids).toEqual(['n_child', 'n_grp']);
});

test('Rename opens the inline editor for a single target', async ({ page }) => {
  await row(page, 'n_box').click(); // single-select
  await row(page, 'n_box').click({ button: 'right' });
  await page.locator('[data-testid="outliner-ctx-rename"]').click();
  await expect(page.locator('[data-testid="scene-tree-rename-n_box"]')).toBeVisible();
});

test('Rename is disabled when the target is a multi-selection', async ({ page }) => {
  await addGroupWithChild(page);
  // Build a 2-node set, then right-click one of them.
  await row(page, 'n_grp').click();
  await row(page, 'n_child').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'n_grp').click({ button: 'right' });
  await expect(page.locator('[data-testid="outliner-ctx-rename"]')).toBeDisabled();
});
