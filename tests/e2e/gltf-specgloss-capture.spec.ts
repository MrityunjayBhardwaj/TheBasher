// glTF spec/gloss direct-import (#214, V53 "REAL-WORLD FINDING — SPEC/GLOSS").
// three.js dropped the KHR_materials_pbrSpecularGlossiness GLTFLoader plugin at
// ~r150 (we're on r169), so a spec/gloss model imports flat-gray unless the
// material is converted: roughness from glossiness, an albedo from diffuse, and —
// for a combined specularGlossinessTexture — a per-pixel BAKED metallicRoughness
// image. The conversion runs AT INGEST, one point before everything that reads the
// file, so render == capture.
//
// THE BOUNDARY-PAIR PROOF (falsifiable). The fixture has TWO spec/gloss
// materials: one with a diffuseTexture + factors (the common case, increment 1),
// one with a combined specularGlossinessTexture (the per-pixel pass, increment 2).
//   side A (the DAG) — each mesh's captured material is normal metal-rough, and the
//     combined material's roughness and metalness maps are ONE baked image.
//   side B (the draw) — the drawn three.js material carries the base map (diffuse)
//     and, for the combined material, a metalnessMap/roughnessMap.
// Pre-fix both materials would be default-white with null maps.
//
// #1071 — the file arrives as native geometry (#1050): every image, including the
// baked one, is stored in the project and named by content hash, so "one baked
// image" is "the same hash". The browser run matters here: the bake draws through a
// canvas that a node probe does not have.

import { test, expect } from './_fixtures';
import { drawnImportMeshes, importedMeshes } from './_importedMesh';

interface CapturedMap {
  hash: string;
  colorSpace: string;
  flipY: boolean;
  store?: string;
}
interface CapturedMaterial {
  name: string;
  base: { color: string; metalness: number };
  specular: { roughness: number };
  maps: {
    albedo: CapturedMap | null;
    roughness: CapturedMap | null;
    metalness: CapturedMap | null;
  };
}
interface BasherWindow {
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function ingestSpecGlossQuad(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/specgloss-quad.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder(
      [{ relativePath: 'specgloss-quad.gltf', bytes }],
      'specgloss',
    );
  });
}

/** Every captured material, keyed by material name, with the road each mesh took. */
const capturedMaterials = async (page: import('@playwright/test').Page) => {
  const out: Record<string, CapturedMaterial & { road: string }> = {};
  for (const mesh of await importedMeshes(page)) {
    for (const m of mesh.slots as (CapturedMaterial | null)[]) {
      if (m) out[m.name] = { ...m, road: mesh.road };
    }
  }
  return out;
};

test.describe('glTF spec/gloss → metal-rough at ingest (#214)', () => {
  test('factor + diffuseTexture material converts; the draw is textured', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestSpecGlossQuad(page);

    // side A — the diffuse spec/gloss material reduced to metal-rough.
    await expect
      .poll(async () => (await capturedMaterials(page))['SGDiffuse']?.name)
      .toBe('SGDiffuse');
    const diffuse = (await capturedMaterials(page))['SGDiffuse'];
    expect(diffuse.road).toBe('native');
    expect(diffuse.base.metalness).toBe(0); // specularFactor 0 → dielectric
    expect(diffuse.specular.roughness).toBeCloseTo(0.6, 5); // 1 - glossiness 0.4
    // diffuseTexture → baseColorTexture, stored in the project as sRGB.
    expect(diffuse.maps.albedo).toMatchObject({ store: 'project', colorSpace: 'srgb' });

    // side B — a drawn mesh carries a decoded base map.
    await expect
      .poll(async () => (await drawnImportMeshes(page)).some((m) => m.hasMap && m.mapImageOk))
      .toBe(true);
  });

  test('combined specularGlossinessTexture bakes an MR map; the draw carries it', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestSpecGlossQuad(page);

    // side A — the combined material has BAKED roughness + metalness maps, both
    // linear, and the factors are 1× (the value lives in the texture).
    await expect
      .poll(async () => (await capturedMaterials(page))['SGCombined']?.maps?.metalness?.store)
      .toBe('project');
    const combined = (await capturedMaterials(page))['SGCombined'];
    expect(combined.road).toBe('native');
    expect(combined.maps.roughness).toMatchObject({ store: 'project', colorSpace: 'srgb-linear' });
    expect(combined.maps.metalness).toMatchObject({ store: 'project', colorSpace: 'srgb-linear' });
    // roughness + metalness share the ONE baked metallicRoughness image.
    expect(combined.maps.roughness?.hash).toBe(combined.maps.metalness?.hash);
    expect(combined.base.metalness).toBe(1); // metallicFactor 1 (texture carries the value)
    expect(combined.specular.roughness).toBe(1); // roughnessFactor 1

    // side B — the drawn material carries a metalness/roughness map (render == capture).
    await expect
      .poll(async () =>
        (await drawnImportMeshes(page)).some((m) => m.hasMetalnessMap || m.hasRoughnessMap),
      )
      .toBe(true);
  });
});
