// #251 / [[H136]] — subtree ops (delete, Shift+D duplicate) must account for
// free-floating KeyframeChannels, which reference their target via params.target
// (V57), NOT an edge. Before the fix: deleting a keyframed object left its channel
// orphaned (pointing at a missing id → invisible save bloat); duplicating produced
// a silently STATIC copy (no channels).
//
// Falsifiable: revert the channel-aware branches in sceneNodeActions.ts → the
// delete assertion finds a leftover channel and the duplicate assertion finds
// only one channel → both fail. Drives the REAL keyboard-shortcut path (which
// calls buildDeleteNodesOps / buildDuplicateNodeOps).

import { test, expect } from './_fixtures';
import { splitCubeOps } from './_splitCube';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, actor?: string, label?: string) => unknown;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
}

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
    timeout: 15000,
  });
  await page.waitForTimeout(400);
}

function channels(page: Page) {
  return page.evaluate(() => {
    const st = (window as unknown as W).__basher_dag!.getState().state;
    return Object.entries(st.nodes)
      .filter(([, n]) => n.type.startsWith('KeyframeChannel'))
      .map(([id, n]) => ({ id, target: (n.params as { target?: string }).target }));
  });
}

function boxes(page: Page) {
  return page.evaluate(() => {
    const st = (window as unknown as W).__basher_dag!.getState().state;
    // Every `Object` in the project — the pose half is the scene child a delete or
    // duplicate acts on, and what the position channels target. NOTE this is not
    // cube-only: the default project's light is an `Object` too, and the camera will
    // be one after its split (#461). Safe here because callers only ever ask for
    // membership or a delta, both of which are unaffected by a constant extra entry.
    // Anything needing "the seed cube" specifically must use _seedNodes.ts instead.
    return Object.keys(st.nodes).filter((id) => st.nodes[id].type === 'Object');
  });
}

async function addKeyframedBox(page: Page, boxId: string, chId: string) {
  await page.evaluate(
    ({ boxId, chId, cubeOps }) => {
      const d = (op: unknown) => (window as unknown as W).__basher_dag!.getState().dispatch(op);
      for (const op of cubeOps as unknown[]) d(op);
      d({
        type: 'connect',
        from: { node: boxId, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      });
      d({
        type: 'addNode',
        nodeId: chId,
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: boxId,
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 1, value: [3, 0, 0], easing: 'linear' },
          ],
        },
      });
    },
    { boxId, chId, cubeOps: splitCubeOps({ objectId: boxId, color: '#88f' }) },
  );
  await page.waitForTimeout(150);
}

test.describe('#251 subtree ops carry free-floating channels', () => {
  test('deleting a keyframed object removes its channel (no orphan)', async ({ page }) => {
    await ready(page);
    await addKeyframedBox(page, 'k_box', 'k_ch');
    expect((await channels(page)).some((c) => c.id === 'k_ch')).toBe(true);

    // Select + real Delete (the keyboard-shortcut path calls buildDeleteNodesOps).
    await page
      .locator('canvas')
      .first()
      .click({ position: { x: 5, y: 5 }, force: true });
    await page.evaluate(() =>
      (window as unknown as W).__basher_selection!.getState().select('k_box'),
    );
    await page.keyboard.press('Delete');
    await page.waitForTimeout(250);

    expect(await boxes(page)).not.toContain('k_box');
    // the channel must be gone too — not orphaned targeting the missing box.
    expect((await channels(page)).some((c) => c.id === 'k_ch' || c.target === 'k_box')).toBe(false);
  });

  test('Shift+D duplicating a keyframed object clones its channel re-targeted', async ({
    page,
  }) => {
    await ready(page);
    await addKeyframedBox(page, 'd_box', 'd_ch');
    const beforeChans = await channels(page);
    const beforeBoxes = await boxes(page);

    await page
      .locator('canvas')
      .first()
      .click({ position: { x: 5, y: 5 }, force: true });
    await page.evaluate(() =>
      (window as unknown as W).__basher_selection!.getState().select('d_box'),
    );
    await page.keyboard.press('Shift+D');
    await page.waitForTimeout(300);

    const afterBoxes = await boxes(page);
    const afterChans = await channels(page);
    // exactly one new box + one new channel.
    expect(afterBoxes.length).toBe(beforeBoxes.length + 1);
    expect(afterChans.length).toBe(beforeChans.length + 1);
    // the new box id (the one that wasn't there before)
    const newBox = afterBoxes.find((b) => !beforeBoxes.includes(b))!;
    // a channel now targets the duplicate — its animation was carried, not dropped.
    expect(afterChans.some((c) => c.target === newBox)).toBe(true);
    // and the original channel still targets the original.
    expect(afterChans.some((c) => c.target === 'd_box')).toBe(true);
  });
});
