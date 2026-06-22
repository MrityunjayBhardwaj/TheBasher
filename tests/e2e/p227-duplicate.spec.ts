// #227 Slice 3 — Duplicate (Shift-D + context-menu). Deep-copies the node's scene
// subtree with fresh ids, wires the copy as a sibling right after the original, and
// selects it. A Group is cloned WITH its children (internal edges re-pointed to the
// clones, not shared). One atomic → one undo.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface DupWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }>; nodes: Record<string, { inputs: { children?: { node: string }[] } }> };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
      undo: () => void;
    };
  };
  __basher_selection: {
    getState: () => { primaryNodeId: string | null; select: (id: string) => void };
  };
}

const sceneChildren = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as DupWindow).__basher_dag.getState().state;
    return (s.nodes[s.outputs.scene.node].inputs.children ?? []).map((c) => c.node);
  });
const primary = (page: Page) =>
  page.evaluate(() => (window as unknown as DupWindow).__basher_selection.getState().primaryNodeId);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as DupWindow).__basher_dag), { timeout: 15000 });
});

test('context-menu Duplicate clones a leaf as a sibling and selects the copy; undo reverts in one step', async ({
  page,
}) => {
  expect(await sceneChildren(page)).toEqual(['n_box']);

  await page.locator('[data-testid="scene-tree-row-n_box"]').click({ button: 'right' });
  await page.locator('[data-testid="outliner-ctx-duplicate"]').click();

  const after = await sceneChildren(page);
  expect(after).toHaveLength(2);
  expect(after[1]).toMatch(/^n_box_copy/);
  expect(await primary(page)).toBe(after[1]);

  await page.evaluate(() => (window as unknown as DupWindow).__basher_dag.getState().undo());
  expect(await sceneChildren(page)).toEqual(['n_box']);
});

test('Shift-D deep-copies a Group subtree (the copy owns CLONED children, not shared)', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as unknown as DupWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'n_grp', nodeType: 'Group', params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] } },
        { type: 'addNode', nodeId: 'n_child', nodeType: 'BoxMesh', params: { size: [2, 2, 2], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { type: 'connect', from: { node: 'n_grp', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'connect', from: { node: 'n_child', socket: 'out' }, to: { node: 'n_grp', socket: 'children' } },
      ],
      'user',
      'group',
    );
    w.__basher_selection.getState().select('n_grp');
  });

  await page.keyboard.press('Shift+D');

  const res = await page.evaluate(() => {
    const w = window as unknown as DupWindow;
    const s = w.__basher_dag.getState().state;
    const kids = (s.nodes[s.outputs.scene.node].inputs.children ?? []).map((c) => c.node);
    const grpCopy = kids.find((id) => id.startsWith('n_grp_copy'))!;
    const grpCopyKids = (s.nodes[grpCopy].inputs.children ?? []).map((c) => c.node);
    return { grpCopy, grpCopyKids, primary: w.__basher_selection.getState().primaryNodeId };
  });

  expect(res.grpCopy).toBeTruthy();
  expect(res.grpCopyKids).toHaveLength(1);
  expect(res.grpCopyKids[0]).not.toBe('n_child'); // a CLONE, not the shared original
  expect(res.primary).toBe(res.grpCopy);
});
