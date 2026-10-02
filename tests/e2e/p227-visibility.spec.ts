// #227 Slice 4 — per-object visibility. The outliner eye on a top-level row
// dispatches a `setHidden` op; the renderer (SceneFromDAG) skips the hidden node
// in the live scene — which the offscreen render also captures (V37, one band) —
// while it stays in the DAG (a view flag, not a structural delete). Undo restores.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { meta?: { hidden?: boolean } }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
      undo: () => void;
    };
  };
  __basher_mesh_world_position: (id: string) => [number, number, number] | null;
  __basher_light_world_positions: () => [number, number, number][];
}

const inLiveScene = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_position('n_box') !== null);

const metaHidden = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes['n_box']?.meta?.hidden ?? false,
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

  // Click the eye → node leaves the live scene, the row marks hidden, meta.hidden set.
  await eye.click();
  await expect.poll(() => inLiveScene(page)).toBe(false);
  await expect(eye).toHaveAttribute('aria-label', 'Show');
  await expect(eye).toHaveAttribute('data-hidden', 'true');
  expect(await metaHidden(page)).toBe(true);
  // Still in the DAG — hiding is a view flag, not a delete.
  expect(
    await page.evaluate(() =>
      Boolean((window as unknown as W).__basher_dag.getState().state.nodes['n_box']),
    ),
  ).toBe(true);

  // Undo restores visibility in one step.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  await expect.poll(() => inLiveScene(page)).toBe(true);
  expect(await metaHidden(page)).toBe(false);
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

// #1448 — the eye on a LIGHT's row. The outliner offers it there (lights are depth-1 rows), and
// it used to set the flag while the light kept lighting the scene: 4 lights before the click and
// 4 after. The light band now skips a hidden light the way the children band skips a child.
test('the outliner eye hides a top-level light: it leaves the live scene, and comes back', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as W).__basher_light_world_positions === 'function',
    { timeout: 15000 },
  );
  const lights = () =>
    page.evaluate(() => (window as unknown as W).__basher_light_world_positions().length);
  await expect.poll(lights).toBeGreaterThan(0);
  const before = await lights();

  const eye = page.getByTestId('scene-tree-eye-n_light');
  await expect(eye).toHaveAttribute('aria-label', 'Hide');
  await eye.click();
  await expect(eye).toHaveAttribute('data-hidden', 'true');
  await expect.poll(lights).toBe(before - 1);

  await eye.click();
  await expect.poll(lights).toBe(before);
});

test('a camera row offers no eye: a camera is chosen, not hidden', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('scene-tree-row-n_camera')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('scene-tree-eye-n_camera')).toHaveCount(0);
});
