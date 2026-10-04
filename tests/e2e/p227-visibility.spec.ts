// #227 Slice 4 — per-object visibility. The outliner eye on a top-level row
// turns the node's `viewport` param off (#1503 — the eye is the viewport's, as Blender's is; the
// render keeps its own `render` flag); the viewport stops drawing it while it stays in the DAG
// (a view flag, not a structural delete). Undo restores.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params?: { viewport?: boolean } }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
      undo: () => void;
    };
  };
  __basher_mesh_world_position: (id: string) => [number, number, number] | null;
}

const inLiveScene = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_position('n_box') !== null);

const viewportOff = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes['n_box']?.params?.viewport ===
      false,
  );

test('the outliner eye hides a top-level node in the live scene but keeps it in the DAG', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_mesh_world_position), {
    timeout: 15000,
  });

  // Visible by default; the eye reads "Hide".
  await expect.poll(() => inLiveScene(page)).toBe(true);
  const eye = page.getByTestId('scene-tree-eye-n_box');
  await expect(eye).toHaveAttribute('aria-label', 'Hide');

  // Click the eye → the viewport stops drawing it, the row marks hidden, its viewport flag is off.
  await eye.click();
  await expect.poll(() => inLiveScene(page)).toBe(false);
  await expect(eye).toHaveAttribute('aria-label', 'Show');
  await expect(eye).toHaveAttribute('data-hidden', 'true');
  expect(await viewportOff(page)).toBe(true);
  // Still in the DAG — hiding is a view flag, not a delete.
  expect(
    await page.evaluate(() =>
      Boolean((window as unknown as W).__basher_dag.getState().state.nodes['n_box']),
    ),
  ).toBe(true);

  // Undo restores visibility in one step.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect.poll(() => inLiveScene(page)).toBe(true);
  expect(await viewportOff(page)).toBe(false);
});

test('clicking the eye does not change the selection', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_mesh_world_position), {
    timeout: 15000,
  });
  // Select the Scene root, then click the box's eye — selection must stay on the
  // root (the eye stops propagation so it never re-fires the row's select).
  const sceneId = await page.evaluate(
    () =>
      (window as unknown as W).__basher_dag.getState().state &&
      (
        window as unknown as {
          __basher_dag: { getState: () => { state: { outputs: { scene: { node: string } } } } };
        }
      ).__basher_dag.getState().state.outputs.scene.node,
  );
  await page.getByTestId(`scene-tree-row-${sceneId}`).click();
  await page.getByTestId('scene-tree-eye-n_box').click();
  await expect(page.getByTestId(`scene-tree-row-${sceneId}`)).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect(page.getByTestId('scene-tree-row-n_box')).not.toHaveAttribute('data-active', 'true');
});
