// #233 — nearest-SURFACE leaf-pick selection (V75, replaces the UX#7 broad-first
// drill). A SINGLE click on a glTF model selects the LEAF (the GltfChild whose
// visible surface is under the cursor), NOT the whole import. Alt+click selects
// UP one level toward the import root (the Group / asset); at the root it is a
// no-op. There is no double-click drill-in and no Esc pop-out anymore — Esc just
// clears the selection.
//
// This is the BOUNDARY-PAIR gate: it drives a REAL R3F raycast click (the
// make-or-break — proving the hit mesh reaches the wrapper handler via
// e.intersections[0] and maps through the asset's nodeNameMap / stamped ids to
// the GltfChild). The chain math is unit-tested separately (gltfDrillChain.test.ts).
//
// Fixture: the flat multifile glTF (one textured child "Box") → asset + ONE
// GltfChild, so the chain is [root, child] (single level); that's enough to
// prove single-click→leaf and Alt+click→up end-to-end. The starter box is moved
// aside so the imported model is the only thing under the click point.

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

test('#233 single click selects the GltfChild leaf; Alt+click selects up; Esc clears', async ({
  page,
}) => {
  await openStarter(page);

  // Clear the origin so the imported model (at origin) owns the click point:
  // move the starter boxes far aside, and DELETE the camera + light nodes —
  // their helper gizmos (esp. the camera's far=1000 frustum LineSegments) span
  // the origin and would intercept the raycast.
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

  // Import the flat glTF (→ GltfAsset + one GltfChild "Box", under a Group root).
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
    { files: FIXTURE, name: 'p233-gltf' },
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

  // SINGLE click → selects the LEAF (the GltfChild under the cursor), NOT the
  // whole import. This is the #233 inversion of the old broad-first behavior.
  await page.mouse.click(pt!.x, pt!.y);
  await expect.poll(async () => nodeTypeOf(page, await selectedIdOf(page))).toBe('GltfChild');
  const leafId = await selectedIdOf(page);

  // ALT+click at the same spot → selects UP one level (the import root: the
  // Group, or the GltfAsset). The level above the GltfChild.
  await page.keyboard.down('Alt');
  await page.mouse.click(pt!.x, pt!.y);
  await page.keyboard.up('Alt');
  await expect
    .poll(async () => nodeTypeOf(page, await selectedIdOf(page)))
    .toMatch(/Group|GltfAsset/);
  const upId = await selectedIdOf(page);
  expect(upId).not.toBe(leafId);

  // ALT+click again → already at the root → no-op (selection stays put).
  await page.keyboard.down('Alt');
  await page.mouse.click(pt!.x, pt!.y);
  await page.keyboard.up('Alt');
  await expect.poll(() => selectedIdOf(page)).toBe(upId);

  // A plain (non-Alt) click re-selects the leaf — proving click is stateless
  // nearest-surface, not a depth that has to be reset.
  await page.mouse.click(pt!.x, pt!.y);
  await expect.poll(() => selectedIdOf(page)).toBe(leafId);

  // Esc → clears the selection (no more drill pop-out ladder).
  await page.keyboard.press('Escape');
  await expect.poll(() => selectedIdOf(page)).toBeNull();
});
