// #227 Slice 5(c) — arrow-key tree navigation (ARIA tree pattern, roving
// tabindex). Up/Down move the active row; Right expands a collapsed container or
// steps into its first child; Left collapses an expanded container or steps to the
// parent; Enter/Space (re)select. The focused row owns these keys — Space selects
// the row WITHOUT toggling global playback (stopPropagation before window).

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void; primaryNodeId: string | null } };
}

const primary = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as W).__basher_selection.getState().primaryNodeId);

test('arrow keys navigate the tree; right/left expand/collapse', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), { timeout: 15000 });

  // Scene → Group(n_box). Default project also has n_camera, n_light as siblings.
  await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_grp',
          nodeType: 'Group',
          params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        { type: 'connect', from: { node: 'n_grp', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'disconnect', from: { node: 'n_box', socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        { type: 'connect', from: { node: 'n_box', socket: 'out' }, to: { node: 'n_grp', socket: 'children' } },
      ],
      'user',
      'group the box',
    );
  });

  // Select the Group row, then drive the keyboard from it.
  await page.getByTestId('scene-tree-row-n_grp').click();
  expect(await primary(page)).toBe('n_grp');
  await page.getByTestId('scene-tree-row-n_grp').focus();

  // ArrowRight on an EXPANDED group with children → steps into first child (n_box).
  await page.keyboard.press('ArrowRight');
  expect(await primary(page)).toBe('n_box');

  // ArrowLeft on a leaf → steps back to the parent group.
  await page.keyboard.press('ArrowLeft');
  expect(await primary(page)).toBe('n_grp');

  // ArrowLeft again on an expanded group → collapses it (no parent move yet).
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('scene-tree-row-n_grp')).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByTestId('scene-tree-row-n_box')).toHaveCount(0);
  expect(await primary(page)).toBe('n_grp');

  // ArrowRight on a collapsed group → re-expands it.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('scene-tree-row-n_grp')).toHaveAttribute('data-expanded', 'true');

  // ArrowUp moves to the previous visible row (the Scene root).
  await page.keyboard.press('ArrowUp');
  const top = await primary(page);
  expect(top).not.toBe('n_grp');

  // ArrowDown returns to the group.
  await page.keyboard.press('ArrowDown');
  expect(await primary(page)).toBe('n_grp');

  // Space on a focused row selects it WITHOUT toggling global playback.
  const playingBefore = await page.evaluate(() => {
    const w = window as unknown as { __basher_time?: { getState: () => { playing: boolean } } };
    return w.__basher_time?.getState().playing ?? null;
  });
  await page.keyboard.press('Space');
  const playingAfter = await page.evaluate(() => {
    const w = window as unknown as { __basher_time?: { getState: () => { playing: boolean } } };
    return w.__basher_time?.getState().playing ?? null;
  });
  expect(playingAfter).toBe(playingBefore);
  expect(await primary(page)).toBe('n_grp');
});
