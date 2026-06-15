// #178 (S3) — the renderer reads a glTF child's DAG-captured OpenPBR material
// (S2) and overlays it onto the imported clone, preserving the clone's textures.
//
// THE PROOF (falsifiable): import cube-draco → its GltfChild 'cube' carries a
// captured materials[0]; editing that material's base.color via setParam changes
// the RENDERED material colour on the clone (read back through __basher_gltf_meshes,
// which inspects the live three.js material). If the renderer ignored the DAG
// material (the pre-fix depNodesById no-op), the colour would never change.

import { test, expect } from './_fixtures';

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

function cubeChild(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = Object.values(w.__basher_dag.getState().state.nodes);
    const c = nodes.find((n) => n.type === 'GltfChild' && n.params.childName === 'cube');
    return c
      ? { id: c.id, materials: c.params.materials as { base: { color: string } }[] | undefined }
      : null;
  });
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

    // Edit the DAG material → red, via a whole-`materials` setParam (zod-revalidated).
    await page.evaluate((childId) => {
      const w = window as unknown as BasherWindow;
      const node = w.__basher_dag.getState().state.nodes[childId];
      const mats = (node.params.materials as { base: { color: string } }[]).map((m, i) =>
        i === 0 ? { ...m, base: { ...m.base, color: '#ff0000' } } : m,
      );
      w.__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: childId, paramPath: 'materials', value: mats }],
          'user',
          'edit gltf material',
        );
    }, before!.id);

    // The rendered clone material now reads red (the DAG material drives the render).
    await expect.poll(() => renderedCubeColor(page)).toBe('#ff0000');
    expect(await renderedCubeColor(page)).not.toBe(beforeColor);
  });
});
