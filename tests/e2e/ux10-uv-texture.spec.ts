// UX-BACKLOG #10 — textures in the UV editor.
//
// THE FEATURE: the UVEditor paints the selected mesh's bound base-color (albedo)
// texture as a backdrop UNDER the UV islands, Blender-style. Resolved THROUGH the
// ONE `resolveMeshTexture` — the V33 read-only-projection sibling of the UV-layout
// resolver — so the panel and the `__basher_uv_texture` side-B seam never drift
// (the H40 boundary-pair discipline).
//
// THE PROOF (Lokayata, side B == what the panel draws):
//   - A glTF whose material binds a 64×64 baseColorTexture (flipY=false, glTF
//     convention) → the seam reports an `ok` 64×64 image with flipY=false for both
//     the whole asset and the textured child.
//   - A mesh with NO base-color map (the default BoxMesh; the metallic-roughness-
//     only quad) → `none`, no image. The grid-only path is unchanged.

import { test, expect } from './_fixtures';

const ASSET_REF = 'assets/albedo-textured-quad.gltf';
const FIXTURE_URL = '/assets/albedo-textured-quad.gltf';
const PLAIN_REF = 'assets/two-material-textured-quad.gltf'; // metallic-roughness map only, NO base color
const PLAIN_URL = '/assets/two-material-textured-quad.gltf';

interface TexResult {
  status: string;
  hasImage: boolean;
  width: number;
  height: number;
  flipY: boolean;
}
interface BasherWindow {
  __basher_uv_texture?: (nodeId: string) => TexResult;
  __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<{ gltfAssetId: string }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_meshes?: () => { slot: number }[];
}

async function importGltf(page: import('@playwright/test').Page, url: string, ref: string) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return (
      typeof w.__basher_uv_texture === 'function' &&
      typeof w.__basher_importGltf === 'function' &&
      typeof w.__basher_writeOpfsBytes === 'function'
    );
  });
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    { url, ref },
  );
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : []).length >= 1;
  });
}

function findNode(page: import('@playwright/test').Page, type: string) {
  return page.evaluate((t: string) => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    return Object.keys(nodes).find((id) => nodes[id].type === t) ?? null;
  }, type);
}

/** Poll the seam until the async clone/decode settles out of 'loading'. */
function readTexture(page: import('@playwright/test').Page, id: string) {
  return page.evaluate(async (nodeId: string) => {
    const w = window as unknown as BasherWindow;
    for (let i = 0; i < 60; i++) {
      const r = w.__basher_uv_texture!(nodeId);
      if (r.status !== 'loading') return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    return w.__basher_uv_texture!(nodeId);
  }, id);
}

test.describe('UX #10 — UV-editor texture backdrop', () => {
  test('glTF base-color map → seam reports an ok 64×64 flipY=false image (asset + child)', async ({
    page,
  }) => {
    await page.goto('/');
    await importGltf(page, FIXTURE_URL, ASSET_REF);

    const assetId = await findNode(page, 'GltfAsset');
    const childId = await findNode(page, 'GltfChild');
    expect(assetId).not.toBeNull();
    expect(childId).not.toBeNull();

    for (const id of [assetId!, childId!]) {
      const tex = await readTexture(page, id);
      console.log(`[ux10 tex ${id}] ${JSON.stringify(tex)}`);
      expect(tex.status).toBe('ok');
      expect(tex.hasImage).toBe(true);
      expect(tex.width).toBe(64);
      expect(tex.height).toBe(64);
      // glTF textures are flipY=false (top-left UV origin); the backdrop flip
      // depends on this flag (V48).
      expect(tex.flipY).toBe(false);
    }
  });

  test('a mesh with no base-color map → none, no backdrop (grid-only path intact)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_uv_texture === 'function',
    );

    // Default BoxMesh carries no texture.
    const box = await readTexture(page, 'n_box');
    console.log(`[ux10 tex n_box] ${JSON.stringify(box)}`);
    expect(box.status).toBe('none');
    expect(box.hasImage).toBe(false);

    // A glTF whose only texture is a metallic-roughness map (NOT base color) is
    // still "no backdrop" — the editor shows base color only.
    await importGltf(page, PLAIN_URL, PLAIN_REF);
    const childId = await findNode(page, 'GltfChild');
    const child = await readTexture(page, childId!);
    console.log(`[ux10 tex plain child ${childId}] ${JSON.stringify(child)}`);
    expect(child.status).toBe('none');
    expect(child.hasImage).toBe(false);
  });
});
