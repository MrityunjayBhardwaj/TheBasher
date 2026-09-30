// #178 (S3) — the renderer reads an imported mesh's DAG-captured OpenPBR material.
//
// THE PROOF (falsifiable): import cube-draco → its data node carries the captured
// material; editing that material's base.color via setParam changes the RENDERED
// material colour (read off the live three.js material the import draws). If the
// renderer ignored the DAG material, the colour would never change.
//
// #1053 — the import is native (`PolyMeshData`); the clone road is retired.

import { test, expect } from './_fixtures';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';

const FOLDER = 'matdag';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function ingestCube(page: import('@playwright/test').Page): Promise<void> {
  // #1053 — cube-draco arrives native (#1063), and the clone road is retired.
  await page.evaluate(async (folder) => {
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await (window as unknown as BasherWindow).__basher_ingestGltfFolder(
      [{ relativePath: 'cube-draco.glb', bytes }],
      folder,
    );
  }, FOLDER);
}

// #389 — the id this spec writes to is the DATA half's, and the captured table is
// `material` (+ `materialSlots`). Both facts come from the one helper; re-spelling the hop
// here would be a copy in the tier the compiler cannot check (#472).
async function cubeChild(page: import('@playwright/test').Page) {
  const child = await firstMaterialMesh(page);
  return child
    ? { id: child.dataId, materials: child.slots as { base: { color: string } }[] }
    : null;
}

const renderedCubeColor = async (page: import('@playwright/test').Page) =>
  (await drawnImportMeshes(page))[0]?.color ?? null;

test.describe('#178 S3 — renderer reads the DAG-captured glTF material', () => {
  test('editing an imported material’s base.color repaints the drawn mesh', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestCube(page);
    // Wait for the mesh to draw + the import to seed its material.
    await expect
      .poll(async () => (await cubeChild(page))?.materials?.length ?? 0)
      .toBeGreaterThan(0);
    await expect.poll(() => renderedCubeColor(page)).toBeTruthy();

    const before = await cubeChild(page);
    const beforeColor = await renderedCubeColor(page);
    expect(before?.materials?.[0].base.color).toBeTruthy();

    // Edit the DAG material → red, via a whole-`material` setParam (zod-revalidated).
    // #389 — slot 0 IS `material` now, so the edit no longer maps over an array; the
    // multi-slot table lives in `materialSlots` and this fixture has one primitive.
    await page.evaluate((dataId) => {
      const w = window as unknown as BasherWindow;
      const node = w.__basher_dag.getState().state.nodes[dataId];
      const mat = node.params.material as { base: { color: string } };
      w.__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId: dataId,
            paramPath: 'material',
            value: { ...mat, base: { ...mat.base, color: '#ff0000' } },
          },
        ],
        'user',
        'edit gltf material',
      );
    }, before!.id);

    // The drawn material now reads red (the DAG material drives the render).
    await expect.poll(() => renderedCubeColor(page)).toBe('#ff0000');
    expect(await renderedCubeColor(page)).not.toBe(beforeColor);
  });
});
