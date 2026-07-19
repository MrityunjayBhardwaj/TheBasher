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
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_mesh_material?: (nodeId: string) => { hasMap: boolean; mapImageOk: boolean } | null;
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

    // The default split cube carries no texture. NOTE (#378): on its own this arm
    // is VACUOUS — 'none' is also what a resolver that never reaches the data node
    // returns, so it cannot tell "reached, no map" from "never reached". The
    // positive pair below is what makes the reach observable; keep them together.
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

  // #378 — the split cube's TEXTURE road as a render==read boundary-pair.
  //
  // The negative arm above ('none' for a bare cube) is vacuous: it passes both when
  // the resolver reaches the BoxData and finds no map, AND when it never reaches the
  // data node at all. So attach a REAL albedo map to the cube's data node and assert
  // the read side (resolveMeshTexture, via __basher_uv_texture on the Object) agrees
  // with the render side (the mounted three.js material, via __basher_mesh_material).
  // 2×2 with an image CANNOT collide with the 0×0/no-image failure value.
  test('split cube + albedo map → UV-editor backdrop matches the RENDERED material (#378)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return (
        typeof w.__basher_uv_texture === 'function' &&
        typeof w.__basher_mesh_material === 'function' &&
        Boolean(w.__basher_selection)
      );
    });

    // Selecting the Object makes the inspector reach through `data`, so the material
    // editor + map row are keyed to the DATA node (n_box_data) while the rendered mesh
    // stays on the Object (n_box) — the split's two sides.
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
    });
    const editor = page.getByTestId('inspector-material-editor-n_box_data');
    if (!(await editor.isVisible())) {
      await page.getByTestId('inspector-section-toggle-material').click();
    }
    await expect(editor).toBeVisible();
    await page
      .getByTestId('inspector-map-file-n_box_data-albedo')
      .setInputFiles('public/fixtures/multifile/flat/texture.png');

    // SIDE A (render) — the mounted material actually carries a decoded map.
    await page.waitForFunction(() => {
      const m = (window as unknown as BasherWindow).__basher_mesh_material!('n_box');
      return m != null && m.hasMap && m.mapImageOk;
    });

    // SIDE B (read) — resolveMeshTexture reaches the same map through the Object.
    const tex = await readTexture(page, 'n_box');
    console.log(`[ux10 tex split-cube #378] ${JSON.stringify(tex)}`);
    expect(tex.status).toBe('ok');
    expect(tex.hasImage).toBe(true);
    expect(tex.width).toBe(2);
    expect(tex.height).toBe(2);
  });
});
