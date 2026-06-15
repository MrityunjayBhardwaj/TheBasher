// #178 (S4) — the inspector MATERIAL section for a GltfChild is EDITABLE: the
// native OpenPBR lobe editor, wired to the child's DAG-captured `materials[]`.
//
// THE PROOF (falsifiable, [[H97]]): import cube-draco → select its GltfChild →
// the MATERIAL section renders editable fields (not the read-only readout). Type
// a new base-colour hex into the inspector → the DAG `materials[0].base.color`
// changes AND the rendered clone repaints (read back through __basher_gltf_meshes,
// the same live-three.js seam S3 uses). If the editor weren't wired to the same
// `materials` the renderer reads, the clone colour would never change.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
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
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'matedit');
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

test.describe('#178 S4 — editable glTF material inspector', () => {
  test('editing base.color via the inspector editor repaints the rendered clone', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestCube(page);
    await expect
      .poll(async () => (await cubeChild(page))?.materials?.length ?? 0)
      .toBeGreaterThan(0);
    await expect.poll(() => renderedCubeColor(page)).toBeTruthy();

    const child = await cubeChild(page);
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_selection.getState().select(id);
    }, child!.id);
    // The MATERIAL section is default-collapsed — expand it.
    await page.getByTestId('inspector-section-toggle-material').click();

    // The EDITABLE editor renders (not the read-only readout).
    const editor = page.getByTestId(`inspector-gltf-material-editor-${child!.id}`);
    await expect(editor).toBeVisible();
    await expect(page.getByTestId('gltf-material-readout')).toHaveCount(0);

    // Type a new base colour into the hex field → commit on Enter.
    const hex = page.getByTestId(`inspector-gltfmat-colorhex-${child!.id}-0-base-color`);
    await hex.fill('#ff0000');
    await hex.press('Enter');

    // Side A: the DAG material updated.
    await expect
      .poll(async () => (await cubeChild(page))?.materials?.[0].base.color)
      .toBe('#ff0000');
    // Side B: the rendered clone repainted (the S3 overlay re-applied on the edit).
    await expect.poll(() => renderedCubeColor(page)).toBe('#ff0000');
  });

  test('editing metalness via the inspector writes the DAG material', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestCube(page);
    await expect
      .poll(async () => (await cubeChild(page))?.materials?.length ?? 0)
      .toBeGreaterThan(0);
    const child = await cubeChild(page);
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_selection.getState().select(id);
    }, child!.id);
    await page.getByTestId('inspector-section-toggle-material').click();

    const num = page.getByTestId(`inspector-gltfmat-num-${child!.id}-0-base-metalness`);
    await expect(num).toBeVisible();
    await num.fill('0.7');

    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = window as unknown as BasherWindow;
          const nodes = Object.values(w.__basher_dag.getState().state.nodes);
          const c = nodes.find((n) => n.type === 'GltfChild' && n.params.childName === 'cube');
          return (c?.params.materials as { base: { metalness: number } }[])?.[0].base.metalness;
        }),
      )
      .toBe(0.7);
  });
});
