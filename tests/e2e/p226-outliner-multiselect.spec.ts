// #226 Slice 2 — outliner multi-select (Blender parity). A plain row click
// replaces the selection; Ctrl/Cmd-click toggles the row in/out of the set;
// Shift-click selects the inclusive range from the active row to the clicked row.
// The active node (primary) is styled distinctly from the other selected members
// (data-active vs data-selected) so a multi-set is legible.
//
// This is the OUTLINER entry point to the same selected SET the viewport
// box-select fills and the multi-gizmo / multi-inspector consume (#225/#226).

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface OutlinerWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { selectedNodeIds: ReadonlySet<string>; primaryNodeId: string | null };
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as OutlinerWindow).__basher_dag), {
    timeout: 15000,
  });
  // Two extra boxes so the tree has n_box, n_box_b, n_box_c in order.
  await page.evaluate(() => {
    const w = window as unknown as OutlinerWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    const ops: unknown[] = [];
    for (const id of ['n_box_b', 'n_box_c']) {
      ops.push({
        type: 'addNode',
        nodeId: id,
        nodeType: 'BoxMesh',
        params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      });
      ops.push({
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      });
    }
    dag.dispatchAtomic(ops, 'user', 'add boxes');
  });
});

const selection = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as OutlinerWindow).__basher_selection.getState();
    return { ids: [...s.selectedNodeIds].sort(), primary: s.primaryNodeId };
  });

const row = (page: Page, id: string) => page.locator(`[data-testid="scene-tree-row-${id}"]`);

test('Ctrl-click adds to the set and makes the clicked row active', async ({ page }) => {
  await row(page, 'n_box').click();
  await row(page, 'n_box_c').click({ modifiers: ['ControlOrMeta'] });

  const s = await selection(page);
  expect(s.ids).toEqual(['n_box', 'n_box_c']);
  expect(s.primary).toBe('n_box_c');

  await expect(row(page, 'n_box_c')).toHaveAttribute('data-active', 'true');
  await expect(row(page, 'n_box')).toHaveAttribute('data-selected', 'true');
  await expect(row(page, 'n_box')).not.toHaveAttribute('data-active', 'true');
});

test('Ctrl-click an already-selected row toggles it back out', async ({ page }) => {
  await row(page, 'n_box').click();
  await row(page, 'n_box_c').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'n_box_c').click({ modifiers: ['ControlOrMeta'] });

  const s = await selection(page);
  expect(s.ids).toEqual(['n_box']);
  expect(s.primary).toBe('n_box');
});

test('Shift-click selects the inclusive range from the active row to the clicked row', async ({
  page,
}) => {
  await row(page, 'n_box').click();
  await row(page, 'n_box_c').click({ modifiers: ['Shift'] });

  const s = await selection(page);
  expect(s.ids).toEqual(['n_box', 'n_box_b', 'n_box_c']);
  expect(s.primary).toBe('n_box_c');
});

test('a multi-set built in the outliner drives the multi-object inspector', async ({ page }) => {
  await row(page, 'n_box').click();
  await row(page, 'n_box_c').click({ modifiers: ['Shift'] });
  await expect(page.locator('[data-testid="inspector-multi-count"]')).toHaveText(
    '3 objects selected',
  );
});
