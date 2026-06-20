// glTF direct-import (texture-maps milestone, V53) — slices 2 & 3:
//   (2) alphaMode:'MASK' + alphaCutoff  → cutout
//   (3) vertex colors (COLOR_0)         → per-vertex tint
//
// THE REFRAMING (grounded): the renderer overlays captured SCALARS onto the
// GLTFLoader clone and NEVER strips alphaTest / vertexColors / side. So for a
// DIRECT import the clone should ALREADY render cutout + vertex colours. These
// tests OBSERVE that on the live clone (side B) AND assert the importer now
// CAPTURES the values into the IR so they are DAG-addressable (side A). Both
// proven on the SAME render — the capture must not change what renders.

import { test, expect } from './_fixtures';

interface MeshSummary {
  name: string;
  alphaTest: number | null;
  transparent: boolean;
  vertexColors: boolean;
  side: number | null;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => MeshSummary[];
}

async function ingest(page: import('@playwright/test').Page, file: string, folder: string) {
  await page.evaluate(
    async ({ file, folder }) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await w.__basher_ingestGltfFolder([{ relativePath: file, bytes }], folder);
    },
    { file, folder },
  );
}

const firstMesh = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [])[0] ?? null;
  });

const childMaterial = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = Object.values(w.__basher_dag.getState().state.nodes);
    const child = nodes.find((n) => n.type === 'GltfChild' && Array.isArray(n.params.materials));
    const mats = child?.params.materials as
      | { geometry?: { alphaCutoff?: number; vertexColors?: boolean } }[]
      | undefined;
    return mats?.[0]?.geometry ?? null;
  });

test.describe('glTF alphaMode + vertex-color — clone renders it + IR captures it', () => {
  test('alphaMode:MASK → clone carries alphaTest; IR captures alphaCutoff', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingest(page, 'cutout-alpha-quad.gltf', 'cutout');

    // side B — the clone ALREADY renders cutout (GLTFLoader set alphaTest=0.5;
    // the scalar overlay preserved it). This confirms the reframing.
    await expect.poll(async () => (await firstMesh(page))?.alphaTest).toBe(0.5);

    // side A — the importer captured alphaCutoff into the IR (DAG-addressable).
    await expect.poll(async () => (await childMaterial(page))?.alphaCutoff).toBe(0.5);
  });

  test('COLOR_0 → clone renders vertex colors; IR captures the flag', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingest(page, 'vertex-color-quad.gltf', 'vcolor');

    // side B — the clone ALREADY renders vertex colours (GLTFLoader set
    // material.vertexColors=true from the COLOR_0 attribute).
    await expect.poll(async () => (await firstMesh(page))?.vertexColors).toBe(true);

    // side A — the importer captured the vertexColors flag into the IR.
    await expect.poll(async () => (await childMaterial(page))?.vertexColors).toBe(true);
  });
});
