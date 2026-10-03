// #233 — nearest-SURFACE leaf-pick selection (V75, replaces the UX#7 broad-first
// drill). A SINGLE click on an imported model selects the LEAF (the imported Object
// whose visible surface is under the cursor), NOT the whole import. Alt+click selects
// UP one level toward the import root (the Group / asset); at the root it is a
// no-op. There is no double-click drill-in and no Esc pop-out anymore — Esc just
// clears the selection.
//
// This is the BOUNDARY-PAIR gate: it drives a REAL R3F raycast click (the
// make-or-break — proving the hit mesh reaches the wrapper handler via
// e.intersections[0] and maps, through the node id stamped on the object that drew
// it, to that Object). The chain math is unit-tested separately (pickChain.test.ts).
//
// Fixture: the flat multifile glTF (one textured child "Box") with its mesh node put under a
// plain parent node (no transform) → the file's empty, a Group, over ONE Object, so the chain is
// [root, child] (single level); that's enough to prove single-click→leaf and Alt+click→up
// end-to-end. #1451 — an import has no wrapper Group any more: the flat file alone would land as
// one Object standing in the scene, both leaf and root, with no level above it to select. The starter box is moved
// aside so the imported model is the only thing under the click point.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, importRoots, importedMeshes } from './_importedMesh';

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

// #1075 — the title named the retired GltfChild kind while this row sat in
// `accepted-failures.txt` (which keys on the title). The row left the baseline in the same
// change that made the spec pass, so the name was retired with it.
test('#233 single click selects the leaf under the cursor; Alt+click selects up; Esc clears', async ({
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

  // Import the flat glTF, its mesh node under a parent node. #1071 — it is a file the native
  // model holds, so it arrives as one `Object` over `PolyMeshData` under the file's empty (a
  // `Group`): the leaf is that Object, the level above it the Group.
  await page.evaluate(
    async ({ files: f, name }) => {
      const w = window as unknown as BasherWindow;
      const files: IngestFileShape[] = [];
      for (const spec of f) {
        let bytes = new Uint8Array(await fetch(spec.urlPath).then((r) => r.arrayBuffer()));
        if (spec.relativePath === 'scene.gltf') {
          const gltf = JSON.parse(new TextDecoder().decode(bytes)) as {
            nodes: Record<string, unknown>[];
            scenes: { nodes: number[] }[];
          };
          gltf.nodes.push({ name: 'p233_parent', children: gltf.scenes[0].nodes });
          gltf.scenes[0].nodes = [gltf.nodes.length - 1];
          bytes = new TextEncoder().encode(JSON.stringify(gltf));
        }
        files.push({ relativePath: spec.relativePath, bytes });
      }
      await w.__basher_ingestGltfFolder!(files, name);
    },
    { files: FIXTURE, name: 'p233-gltf' },
  );

  // #781 — WAIT ON THE IMPORTED MESH, NOT ON A CAMERA.
  //
  // The previous condition was `hasChild && camera != null`. Both halves are satisfied
  // before the thing this spec measures exists: the DAG node appears as soon as the import
  // writes it, and `camera != null` is true the instant the canvas mounts, because R3F
  // supplies a DEFAULT camera. So the wait was satisfied by the wrong object, and under
  // load the spec projected a mesh that had not mounted (`pt === null`) or one still at the
  // origin (the projected point landing on exactly the canvas centre). Measured at 2
  // failures in 5 runs before this.
  //
  // The object under test is the mesh, so that is what is waited on. Keeping the node and
  // camera checks costs nothing and keeps the failure message specific about which half is
  // missing when it times out.
  //
  // #1071 — the mesh is found through the import root on either road (a native mesh has no
  // name to find it by), and the road is asserted so a silent fall-back is visible.
  //
  // #1075 — this was red on a native import until every nested drawn node carried its own
  // id (`RenderChild`); the leaf chain had known only the glTF clone's stamps and name map.
  await expect
    .poll(async () => (await importedMeshes(page)).map((m) => m.road), { timeout: 20_000 })
    .toEqual(['native']);
  const [{ rootId }] = await importRoots(page);
  await expect
    .poll(
      async () => {
        const hasCamera = await page.evaluate(
          () => (window as unknown as BasherWindow).__basher_three?.getState().camera != null,
        );
        return hasCamera && (await drawnImportMeshes(page, rootId)).some((m) => m.visible);
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  // Project the imported model's drawn mesh to canvas pixels — the distractors are moved
  // far aside, so this point hits only the model.
  //
  // ⚠️ The sentence removed here read "Poll: the clone may still be settling right after
  // import." There was no poll — this is a single `evaluate`, and it always was. The
  // comment described the defence the spec needed and did not have, which is exactly how
  // it read as covered. The settling it worried about is now handled where it belongs, in
  // the wait above.
  const pt = await page.evaluate(async (root) => {
    const w = window as unknown as BasherWindow;
    const cam = w.__basher_three!.getState().camera!;
    const scene = w.__basher_three!.getState().scene!;
    let mesh: import('three').Object3D | undefined;
    scene.getObjectByName(root)?.traverse((o) => {
      if (!mesh && (o as import('three').Mesh).isMesh) mesh = o;
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
  }, rootId);
  expect(pt).not.toBeNull();

  // SINGLE click → selects the LEAF (the imported child under the cursor), NOT the
  // whole import. This is the #233 inversion of the old broad-first behavior.
  await page.mouse.click(pt!.x, pt!.y);
  // #389 — the leaf is an ordinary `Object` now, so its TYPE no longer identifies it:
  // a box, a light and a camera are Objects too, and asserting 'Object' here would pass
  // for a click that selected the starter box. Assert IDENTITY instead — the selected
  // id must be one of the asset's imported children.
  await expect
    .poll(async () => {
      const selected = await selectedIdOf(page);
      const meshes = await importedMeshes(page);
      return meshes.some((m) => m.objectId === selected);
    })
    .toBe(true);
  const leafId = await selectedIdOf(page);

  // ALT+click at the same spot → selects UP one level (the import root: the
  // Group, or the GltfAsset). The level above the imported child.
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
