// #256 (V38) — a geometry modifier (Array/Mirror) only reshapes a PRIMITIVE leaf
// mesh (box/sphere/baked); on a glTF / Group source it passes THROUGH unchanged
// (async geometry is a documented v1 follow-up). That silent no-op read as "the
// modifier is broken" on imported assets. The modifier inspector now surfaces the
// limitation so the pass-through is EXPECTED, not a bug.
//
// Falsifiable: remove the unsupported-source note → the first assertion (warning
// visible on a Group-based stack) fails.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag?: { getState: () => { dispatch: (op: unknown, a?: string, l?: string) => unknown } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
}

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
    timeout: 15000,
  });
  await page.waitForTimeout(400);
}

test('modifier stack warns when its source is a non-primitive (passes through)', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const d = (op: unknown) => (window as unknown as W).__basher_dag!.getState().dispatch(op);
    d({ type: 'addNode', nodeId: 'grp7', nodeType: 'Group', params: { position: [0, 0, 0] } });
    // Wire an ArrayModifier as a stack node on the group (group.out → mod.target,
    // mod.out → scene.children) — the shape buildAddModifierOps produces.
    d({
      type: 'addNode',
      nodeId: 'arr7',
      nodeType: 'ArrayModifier',
      params: { count: 3, offset: [2, 0, 0], muted: false },
    });
    d({
      type: 'connect',
      from: { node: 'grp7', socket: 'out' },
      to: { node: 'arr7', socket: 'target' },
    });
    d({
      type: 'connect',
      from: { node: 'arr7', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    });
  });

  // Selecting the modifier node shows the 'modifier' inspector section; its base
  // resolves to the Group → the unsupported-source note appears.
  await page.evaluate(() => (window as unknown as W).__basher_selection!.getState().select('arr7'));
  await expect(page.getByTestId('modifier-unsupported-source')).toBeVisible();
  await expect(page.getByTestId('modifier-unsupported-source')).toContainText('Group');

  // A plain primitive (Box) is a supported source → no note.
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection!.getState().select('n_box'),
  );
  await expect(page.getByTestId('modifier-unsupported-source')).toHaveCount(0);
});
