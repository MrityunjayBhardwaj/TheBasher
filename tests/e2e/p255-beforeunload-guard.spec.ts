// #255 — the beforeunload guard: closing / reloading with UNSAVED changes must
// trigger the browser's native "leave site?" prompt, but a clean project must
// not nag. Observed via a synthetic cancelable 'beforeunload' event — the guard
// calls preventDefault() only when the project is dirty.
//
// Falsifiable: remove the beforeunload listener (or its dirty check) → the
// dirty-state assertion below sees defaultPrevented === false and fails.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag?: { getState: () => { dispatch: (op: unknown, a?: string, l?: string) => unknown } };
}

function dispatchBeforeUnload(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

test('beforeunload prompts only when there are unsaved changes', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
    timeout: 15000,
  });
  await page.waitForTimeout(400);

  // Clean (just booted / resumed): no dirty dot, unload not blocked.
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);
  expect(await dispatchBeforeUnload(page)).toBe(false);

  // A real edit flips the project dirty. The box's size lives on its DATA node: this
  // once wrote `size` onto the Object `n_box`, which the schema refuses and which changed
  // nothing — the test passed only because a refused write still marked the project
  // unsaved (#1189). Aimed at the owner, and read back, so it is an edit.
  const size = await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag!;
    dag
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: 'n_box_data', paramPath: 'size', value: [2, 2, 2] },
        'user',
        'p255 edit',
      );
    return (
      dag.getState() as unknown as {
        state: { nodes: Record<string, { params: { size: number[] } }> };
      }
    ).state.nodes.n_box_data.params.size;
  });
  expect(size).toEqual([2, 2, 2]);
  await expect(page.getByTestId('project-tab-dirty-dot')).toBeVisible();

  // Now the unload is blocked (native prompt would show).
  expect(await dispatchBeforeUnload(page)).toBe(true);
});
