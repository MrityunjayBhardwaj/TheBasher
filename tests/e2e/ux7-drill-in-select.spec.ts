// UX #7 — double-click drill-in selection. A single click on a glTF model
// selects the whole import; a double-click drills to the GltfChild under the
// cursor; Esc pops back up. This is the BOUNDARY-PAIR gate: it drives a REAL
// R3F raycast double-click (the make-or-break — proving the hit mesh reaches
// the wrapper handler as e.object and maps through nodeNameMap to the
// GltfChild). The chain math + drill-store stepping are unit-tested separately
// (gltfDrillChain.test.ts, drillStore.test.ts).
//
// Fixture: the flat multifile glTF (one textured child "Box") → asset + ONE
// GltfChild, so the drill is single-level (asset → child); that's enough to
// prove the wiring end-to-end. The starter box is moved aside so the imported
// model is the only thing under the click point (deterministic raycast).

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

const KEY = 'basher.lastProjectId';

interface DagNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
}
interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, DagNode> };
      dispatch: (op: unknown, source?: string, description?: string) => void;
    };
  };
  __basher_selection?: { getState: () => { selectedNodeId: string | null } };
  __basher_three?: {
    getState: () => { camera: import('three').Camera | null; scene: import('three').Scene | null };
  };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<IngestFileShape>,
    folderName: string,
  ) => Promise<string>;
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
}

const FIXTURE = [
  { urlPath: '/fixtures/multifile/flat/scene.gltf', relativePath: 'scene.gltf' },
  { urlPath: '/fixtures/multifile/flat/scene.bin', relativePath: 'scene.bin' },
  { urlPath: '/fixtures/multifile/flat/texture.png', relativePath: 'texture.png' },
];

async function openStarter(page: Page): Promise<void> {
  await page.addInitScript((k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage disabled */
    }
  }, KEY);
  await page.goto('/');
  await expect(page.getByTestId('home-view')).toBeVisible();
  await page.getByTestId('home-open-example_starter').click();
  await expect(page.getByTestId('layout')).toBeVisible();
  await expect(page.getByTestId('viewport').locator('canvas')).toHaveCount(1);
}

const selectedIdOf = (page: Page): Promise<string | null> =>
  page.evaluate(
    () => (window as unknown as BasherWindow).__basher_selection!.getState().selectedNodeId,
  );

const nodeTypeOf = (page: Page, id: string | null): Promise<string | null> =>
  page.evaluate((nid) => {
    if (!nid) return null;
    return (
      (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[nid]?.type ?? null
    );
  }, id);

test('UX#7 double-click drills the import → GltfChild; Esc pops back up', async ({ page }) => {
  await openStarter(page);

  // Clear the origin so the imported model (at origin) owns the click point:
  // move the starter boxes far aside, and DELETE the camera + light nodes —
  // their helper gizmos (esp. the camera's far=1000 frustum LineSegments) span
  // the origin and would intercept the raycast. (Starter scene =
  // n_camera, n_light, n_box@[-0.7,0,0], n_box_2@[0.9,0,-0.4].)
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    dag.dispatch(
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [20, 0, 0] },
      'user',
      'aside',
    );
    dag.dispatch(
      { type: 'setParam', nodeId: 'n_box_2', paramPath: 'position', value: [20, 0, 0] },
      'user',
      'aside',
    );
    // disconnect then remove (removeNode refuses while still consumed)
    dag.dispatch(
      {
        type: 'disconnect',
        from: { node: 'n_camera', socket: 'out' },
        to: { node: 'n_scene', socket: 'camera' },
      },
      'user',
      'rm cam',
    );
    dag.dispatch({ type: 'removeNode', nodeId: 'n_camera' }, 'user', 'rm cam');
    dag.dispatch(
      {
        type: 'disconnect',
        from: { node: 'n_light', socket: 'out' },
        to: { node: 'n_scene', socket: 'lights' },
      },
      'user',
      'rm light',
    );
    dag.dispatch({ type: 'removeNode', nodeId: 'n_light' }, 'user', 'rm light');
  });

  // Import the flat glTF (→ GltfAsset + one GltfChild "Box").
  await page.evaluate(
    async ({ files: f, name }) => {
      const w = window as unknown as BasherWindow;
      const files: IngestFileShape[] = [];
      for (const spec of f) {
        const buf = await fetch(spec.urlPath).then((r) => r.arrayBuffer());
        files.push({ relativePath: spec.relativePath, bytes: new Uint8Array(buf) });
      }
      await w.__basher_ingestGltfFolder!(files, name);
    },
    { files: FIXTURE, name: 'ux7-gltf' },
  );

  // Wait for the asset + its GltfChild to exist and the camera seam to land.
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag?.getState().state.nodes ?? {};
      const hasChild = Object.values(nodes).some((n) => n.type === 'GltfChild');
      return hasChild && w.__basher_three?.getState().camera != null;
    },
    undefined,
    { timeout: 20_000 },
  );

  const assetId = await page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    return Object.entries(nodes).find(([, n]) => n.type === 'GltfAsset')?.[0] ?? null;
  });
  expect(assetId).not.toBeNull();

  // Project the imported model's actual "Box" mesh (in the live scene clone) to
  // canvas pixels — the distractors are moved far aside, so this point hits only
  // the model. Poll: the clone may still be settling right after import.
  const pt = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const cam = w.__basher_three!.getState().camera!;
    const scene = w.__basher_three!.getState().scene!;
    let mesh: import('three').Object3D | undefined;
    scene.traverse((o) => {
      if (!mesh && o.name === 'Box' && (o as import('three').Mesh).isMesh) mesh = o;
    });
    if (!mesh) return null;
    mesh.updateWorldMatrix(true, false);
    const p = mesh.getWorldPosition(
      new (cam.position.constructor as new () => import('three').Vector3)(),
    );
    cam.updateMatrixWorld();
    const v = p.project(cam);
    const canvas = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  });
  expect(pt).not.toBeNull();

  // SINGLE click → selects the whole import (its top-level Group wrapper, with
  // the GltfAsset nested inside). Proves the raycast hits the imported model at
  // centre, not a starter node. Capture that top id — Esc should pop back to it.
  await page.mouse.click(pt!.x, pt!.y);
  await expect
    .poll(async () => nodeTypeOf(page, await selectedIdOf(page)))
    .toMatch(/Group|GltfAsset/);
  const topId = await selectedIdOf(page);

  // DOUBLE click → drills into the GltfChild under the cursor.
  await page.mouse.dblclick(pt!.x, pt!.y);
  await expect.poll(async () => nodeTypeOf(page, await selectedIdOf(page))).toBe('GltfChild');

  // Esc → pops back up one level to the whole import.
  await page.keyboard.press('Escape');
  await expect.poll(() => selectedIdOf(page)).toBe(topId);

  // Esc again → past the top → clears.
  await page.keyboard.press('Escape');
  await expect.poll(() => selectedIdOf(page)).toBeNull();
});
