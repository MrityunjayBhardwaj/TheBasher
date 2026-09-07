// #178 (S3) — the renderer reads a glTF child's DAG-captured OpenPBR material
// (S2) and overlays it onto the imported clone, preserving the clone's textures.
//
// THE PROOF (falsifiable): import cube-draco → its GltfChild 'cube' carries a
// captured materials[0]; editing that material's base.color via setParam changes
// the RENDERED material colour on the clone (read back through __basher_gltf_meshes,
// which inspects the live three.js material). If the renderer ignored the DAG
// material (the pre-fix depNodesById no-op), the colour would never change.

import { test, expect } from './_fixtures';
import { importedChild } from './_importedChild';

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
  __basher_gltf_meshes?: () => { name: string; color: string | null; hasMap: boolean }[];
}

async function ingestCube(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'matdag');
  });
}

// #389 — the child is an `Object` + `GltfData` pair now, so the id this spec writes to is
// the DATA half's and the captured table is `material` + `materialSlots` rather than a
// `materials` array. Both facts come from the one helper; re-spelling the hop here would
// be a copy in the tier the compiler cannot check (#472).
async function cubeChild(page: import('@playwright/test').Page) {
  const child = await importedChild(page, 'cube');
  return child
    ? { id: child.dataId, materials: child.slots as { base: { color: string } }[] }
    : null;
}

const renderedCubeColor = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const m = (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : []).find(
      (s) => s.name === 'cube',
    );
    return m ? m.color : null;
  });

test.describe('#178 S3 — renderer reads the DAG-captured glTF material', () => {
  test('editing a GltfChild material base.color repaints the rendered clone', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestCube(page);
    // Wait for the clone to mount + the import to seed materials.
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

    // The rendered clone material now reads red (the DAG material drives the render).
    await expect.poll(() => renderedCubeColor(page)).toBe('#ff0000');
    expect(await renderedCubeColor(page)).not.toBe(beforeColor);
  });
});
