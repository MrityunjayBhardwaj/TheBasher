// #231 Inc 3.2 — the multi-camera "active" model UI. A 2nd camera appears in the
// outliner with a "Set Active" affordance; setting it active lazily inserts a
// CameraSelect (V79) and the active marker + the resolved active camera follow.
// Proven on the DAG (scene.camera → CameraSelect, active resolves to the chosen
// camera) AND the outliner marker, via the outliner button and the Ctrl-0 shortcut.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface CamRef {
  node: string;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: Record<string, { node: string }>;
        nodes: Record<
          string,
          {
            type: string;
            params: Record<string, unknown>;
            inputs: Record<string, CamRef | CamRef[]>;
          }
        >;
      };
      dispatch: (op: unknown) => void;
    };
  };
}

/** In-page mirror of selectActiveCameraNode: resolve scene.camera THROUGH a
 *  CameraSelect (by clamped `active` index over its `cameras` edge order). */
const activeCameraId = (page: Page) =>
  page.evaluate(() => {
    const st = (window as unknown as W).__basher_dag.getState().state;
    const scene = st.nodes[st.outputs.scene.node];
    const camBind = scene.inputs.camera as CamRef | CamRef[] | undefined;
    const ref = Array.isArray(camBind) ? camBind[0] : camBind;
    if (!ref?.node) return null;
    const node = st.nodes[ref.node];
    if (!node) return null;
    if (node.type !== 'CameraSelect') return node === undefined ? null : ref.node;
    const edges = (node.inputs.cameras as CamRef[]) ?? [];
    if (edges.length === 0) return null;
    let i = Math.round((node.params.active as number) ?? 0);
    if (i < 0) i = 0;
    if (i >= edges.length) i = edges.length - 1;
    return edges[i]?.node ?? null;
  });

const SEED = 'n_camera';
const CAM2 = 'n_cam2';

async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
    timeout: 15000,
  });
}

async function addSecondCamera(page: Page) {
  await page.evaluate((id) => {
    const w = window as unknown as W;
    w.__basher_dag.getState().dispatch({
      type: 'addNode',
      nodeId: id,
      nodeType: 'PerspectiveCamera',
      params: { position: [0, 6, 0], lookAt: [0, 0, 0], fov: 50 },
    });
  }, CAM2);
}

test.describe('#231 Inc 3.2 — multi-camera active model', () => {
  test('a 2nd camera shows in the outliner; Set Active moves the active camera', async ({
    page,
  }) => {
    await boot(page);
    await addSecondCamera(page);

    // Both cameras project as outliner rows.
    await expect(page.locator(`[data-testid="scene-tree-row-${SEED}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="scene-tree-row-${CAM2}"]`)).toBeVisible();

    // The seed camera is active (direct-wired) → solid-triangle marker on its row;
    // the 2nd camera offers a Set Active button.
    await expect(page.locator(`[data-testid="scene-tree-active-camera-${SEED}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="scene-tree-set-active-${CAM2}"]`)).toBeVisible();
    expect(await activeCameraId(page)).toBe(SEED);
    // Observe the active (seed) camera's frustum with the solid triangle, framed.
    await page.screenshot({ path: 'test-results/p231-active-camera-seed.png' });

    // Set the 2nd camera active via its outliner button.
    await page.locator(`[data-testid="scene-tree-set-active-${CAM2}"]`).click();

    // The resolved active camera + the marker both move to the 2nd camera.
    await expect.poll(() => activeCameraId(page)).toBe(CAM2);
    await expect(page.locator(`[data-testid="scene-tree-active-camera-${CAM2}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="scene-tree-set-active-${SEED}"]`)).toBeVisible();

    // A CameraSelect was lazily inserted and now feeds scene.camera.
    const hasSelect = await page.evaluate(() => {
      const st = (window as unknown as W).__basher_dag.getState().state;
      const scene = st.nodes[st.outputs.scene.node];
      const ref = scene.inputs.camera as CamRef;
      return st.nodes[ref.node]?.type === 'CameraSelect';
    });
    expect(hasSelect).toBe(true);

    // Screenshot: the active frustum (2nd camera, top-down) carries the solid triangle.
    await page.screenshot({ path: 'test-results/p231-active-camera.png' });
  });

  test('Ctrl+0 sets the selected camera active (Blender Ctrl-Numpad0)', async ({ page }) => {
    await boot(page);
    await addSecondCamera(page);
    await page.locator(`[data-testid="scene-tree-set-active-${CAM2}"]`).click();
    await expect.poll(() => activeCameraId(page)).toBe(CAM2);

    // Select the seed camera in the outliner, then Ctrl+0 → it becomes active.
    await page.locator(`[data-testid="scene-tree-row-${SEED}"]`).click();
    await page.keyboard.press('Control+0');
    await expect.poll(() => activeCameraId(page)).toBe(SEED);
  });
});
