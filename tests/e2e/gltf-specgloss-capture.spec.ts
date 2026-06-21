// glTF spec/gloss direct-import (#214, V53 "REAL-WORLD FINDING — SPEC/GLOSS").
// three.js dropped the KHR_materials_pbrSpecularGlossiness GLTFLoader plugin at
// ~r150 (we're on r169), so a spec/gloss model imports flat-gray: the render
// clone gets a default white material with NO textures AND the captured IR reads
// only pbrMetallicRoughness (absent → all-default). The fix converts spec/gloss
// → metal-rough AT INGEST (one point before both readers of the OPFS bytes), so
// render == capture.
//
// THE BOUNDARY-PAIR PROOF (falsifiable). The fixture has TWO spec/gloss
// materials: one with a diffuseTexture + factors (the common case, increment 1),
// one with a combined specularGlossinessTexture (the per-pixel pass, increment 2).
//   side A (the DAG IR) — each GltfChild's captured material is normal metal-rough
//     (roughness from glossiness, a baseColor/albedo from diffuse, and — for the
//     combined material — a BAKED metallicRoughness map descriptor).
//   side B (the live clone) — the rendered three.js material carries the base map
//     (diffuse) and, for the combined material, a metalnessMap/roughnessMap.
// Pre-fix both materials would be default-white with null maps (and the required
// extension would break the loader). The two sides agreeing = render == capture.

import { test, expect } from './_fixtures';

interface CapturedMap {
  hash: string;
  colorSpace: string;
  flipY: boolean;
  gltfTexture?: number;
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
  __basher_gltf_meshes?: () => {
    name: string;
    hasMap: boolean;
    hasMetalnessMap: boolean;
    hasRoughnessMap: boolean;
  }[];
}

async function ingestSpecGlossQuad(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/specgloss-quad.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'specgloss-quad.gltf', bytes }], 'specgloss');
  });
}

/** Every captured GltfChild material, keyed by material name. */
const capturedMaterials = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = Object.values(w.__basher_dag.getState().state.nodes);
    const out: Record<string, CapturedMaterial> = {};
    for (const n of nodes) {
      if (n.type !== 'GltfChild' || !Array.isArray(n.params.materials)) continue;
      for (const m of n.params.materials as CapturedMaterial[]) out[m.name] = m;
    }
    return out;
  });

const meshes = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
  });

test.describe('glTF spec/gloss → metal-rough at ingest (#214)', () => {
  test('factor + diffuseTexture material converts; clone renders textured', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestSpecGlossQuad(page);

    // side A — the diffuse spec/gloss material reduced to metal-rough.
    await expect.poll(async () => (await capturedMaterials(page))['SGDiffuse']?.name).toBe(
      'SGDiffuse',
    );
    const mats = await capturedMaterials(page);
    const diffuse = mats['SGDiffuse'];
    expect(diffuse.base.metalness).toBe(0); // specularFactor 0 → dielectric
    expect(diffuse.specular.roughness).toBeCloseTo(0.6, 5); // 1 - glossiness 0.4
    // diffuseTexture → baseColorTexture, captured as an sRGB imported descriptor.
    expect(diffuse.maps.albedo).toMatchObject({ hash: '', colorSpace: 'srgb', gltfTexture: 0 });

    // side B — a clone mesh still carries the base map (render byte-faithful).
    await expect.poll(async () => (await meshes(page)).some((m) => m.hasMap)).toBe(true);
  });

  test('combined specularGlossinessTexture bakes an MR map; clone renders it', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestSpecGlossQuad(page);

    // side A — the combined material has BAKED roughness + metalness map
    // descriptors (a new glTF texture, index ≥ 2, beyond the fixture's two),
    // both linear, and the factors are 1× (the value lives in the texture).
    await expect
      .poll(async () => (await capturedMaterials(page))['SGCombined']?.maps?.metalness?.gltfTexture)
      .toBeGreaterThanOrEqual(2);
    const combined = (await capturedMaterials(page))['SGCombined'];
    expect(combined.maps.roughness).toMatchObject({ hash: '', colorSpace: 'srgb-linear' });
    expect(combined.maps.metalness).toMatchObject({ hash: '', colorSpace: 'srgb-linear' });
    // roughness + metalness share the ONE baked metallicRoughness texture.
    expect(combined.maps.roughness?.gltfTexture).toBe(combined.maps.metalness?.gltfTexture);
    expect(combined.base.metalness).toBe(1); // metallicFactor 1 (texture carries the value)
    expect(combined.specular.roughness).toBe(1); // roughnessFactor 1

    // side B — the rendered clone carries a metalness/roughness map (the baked
    // sibling loaded; render == capture).
    await expect
      .poll(async () => (await meshes(page)).some((m) => m.hasMetalnessMap || m.hasRoughnessMap))
      .toBe(true);
  });
});
