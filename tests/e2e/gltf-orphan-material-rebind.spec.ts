// #221 — a glTF whose single mesh primitive has NO `material` while the file
// defines one orphaned textured material (the 3dripper export bug) is REPAIRED at
// ingest: the unbound primitive is bound to the orphan, so the model imports
// TEXTURED instead of rendering the default white material.
//
// THE PROOF (falsifiable, boundary-pair): import orphan-material-quad.gltf →
// assert BOTH side A (the captured IR material is M_Orphan, not "default") AND
// side B (the rendered clone carries a base map + the material's doubleSided flag,
// via __basher_gltf_meshes — the live seam the renderer feeds). Without the rebind
// the primitive gets three.js's default material → IR "default", clone map=false,
// side=FrontSide.

import { test, expect } from './_fixtures';

const DOUBLE_SIDE = 2; // THREE.DoubleSide

interface MeshSummary {
  name: string;
  color: string;
  hasMap: boolean;
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
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(
    async ([f, name]) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${f}`).then((r) => r.arrayBuffer()));
      await w.__basher_ingestGltfFolder([{ relativePath: f, bytes }], name);
    },
    [file, folder] as const,
  );
}

/** The captured-material name of the first GltfChild that carries materials. */
function capturedMaterialName(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && Array.isArray(n.params.materials),
    );
    if (!c) return null;
    return (c.params.materials as { name?: string }[])[0]?.name ?? null;
  });
}

const firstMesh = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [])[0] ?? null;
  });

test.describe('#221 — orphan-material rebind on import', () => {
  test('an unbound primitive is bound to the file\'s one orphaned material', async ({ page }) => {
    await ingest(page, 'orphan-material-quad.gltf', 'orphan');

    // Side A — the captured IR material is the file's M_Orphan (NOT the three.js
    // default material the unbound primitive would otherwise have received).
    await expect.poll(async () => await capturedMaterialName(page)).toBe('M_Orphan');

    // Side B — the rendered clone carries the material's base map + doubleSided
    // flag, i.e. the geometry now uses M_Orphan, not the flat default material.
    await expect.poll(async () => (await firstMesh(page))?.hasMap).toBe(true);
    await expect.poll(async () => (await firstMesh(page))?.side).toBe(DOUBLE_SIDE);
  });
});
