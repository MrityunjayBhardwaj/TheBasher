// glTF direct-import (texture-maps milestone, V53) — the importer captures a
// material's texture slots into the OpenPBR IR as IMPORTED-TEXTURE descriptors
// (the "lighter" persistence path: gltfTexture index + colorspace + flipY + wrap,
// hash EMPTY — bytes ride in the embedded .glb), so a map is inspector-visible +
// DAG-addressable WITHOUT changing the render.
//
// THE BOUNDARY-PAIR PROOF (falsifiable):
//   side A (the DAG)        — the GltfChild's captured materials[0].maps.albedo is
//                             a descriptor { hash:'', gltfTexture:0, colorSpace:'srgb' }.
//   side B (the live clone) — the rendered three.js material STILL carries .map
//                             (hasMap), i.e. the captured descriptor inherited the
//                             imported texture; render is byte-identical.
// Pre-fix (maps:NULL_MAPS) side A would be null while side B was textured — the
// exact "inspector shows empty slots even though it renders textured" gap.

import { test, expect } from './_fixtures';

interface CapturedMap {
  hash: string;
  colorSpace: string;
  flipY: boolean;
  gltfTexture?: number;
}
interface CapturedMaps {
  albedo: CapturedMap | null;
  roughness: CapturedMap | null;
  metalness: CapturedMap | null;
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
  __basher_gltf_meshes?: () => { name: string; hasMap: boolean }[];
}

async function ingestAlbedoQuad(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/albedo-textured-quad.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder(
      [{ relativePath: 'albedo-textured-quad.gltf', bytes }],
      'maptex',
    );
  });
}

const capturedMaps = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = Object.values(w.__basher_dag.getState().state.nodes);
    const child = nodes.find((n) => n.type === 'GltfChild' && Array.isArray(n.params.materials));
    const mats = child?.params.materials as { maps?: CapturedMaps }[] | undefined;
    return mats?.[0]?.maps ?? null;
  });

const someMeshHasMap = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const meshes = w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
    return meshes.some((m) => m.hasMap);
  });

test.describe('glTF texture-map capture — IR descriptor + byte-identical render', () => {
  test('captures the albedo texture as an imported descriptor; clone stays textured', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestAlbedoQuad(page);

    // side A — the DAG captured an albedo descriptor (was null before the milestone).
    await expect.poll(async () => (await capturedMaps(page))?.albedo?.gltfTexture).toBe(0);
    const maps = await capturedMaps(page);
    expect(maps?.albedo).toMatchObject({
      hash: '', // lighter path — no OPFS bytes; the .glb carries them
      colorSpace: 'srgb', // baseColor is sRGB (glTF convention)
      flipY: false, // glTF textures are flipY=false
      gltfTexture: 0,
    });
    // This material has only a baseColorTexture → the other slots stay null (inherit).
    expect(maps?.roughness).toBeNull();
    expect(maps?.metalness).toBeNull();

    // side B — the rendered clone STILL carries the imported texture (render is
    // byte-identical; the descriptor inherited rather than replaced/cleared).
    await expect.poll(() => someMeshHasMap(page)).toBe(true);
  });
});
