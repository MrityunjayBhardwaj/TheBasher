// glTF direct-import (texture-maps milestone, V53) — the importer captures a
// material's texture slots into the OpenPBR IR, so a map is inspector-visible +
// DAG-addressable, and what is drawn is the captured texture.
//
// #1050 / #1071 — a textured file now arrives as native geometry. The captured map is
// no longer an "inherit the file's texture" descriptor (`gltfTexture` + an empty hash):
// the image's own bytes are stored in the project, and the map names that file by its
// content hash. Nothing reads the glTF after import.
//
// THE BOUNDARY-PAIR PROOF (falsifiable):
//   side A (the DAG)   — the mesh's captured material has an albedo map stored in the
//                        project ({ store:'project', hash:'<sha256>.png', srgb, flipY false }).
//   side B (the draw)  — the drawn three.js material carries a decoded base map.
// A capture that dropped the map reds side A; a draw that ignored it reds side B.

import { test, expect } from './_fixtures';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';

interface CapturedMap {
  hash: string;
  colorSpace: string;
  flipY: boolean;
  store?: string;
}
interface CapturedMaps {
  albedo: CapturedMap | null;
  roughness: CapturedMap | null;
  metalness: CapturedMap | null;
}
interface BasherWindow {
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

/** A project image key: the image's sha256 plus the file's own extension. */
const PROJECT_IMAGE_KEY = /^[0-9a-f]{64}\.(png|jpe?g)$/;

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

const capturedMaps = async (page: import('@playwright/test').Page) => {
  const mesh = await firstMaterialMesh(page);
  return (mesh?.slots[0] as { maps?: CapturedMaps } | undefined)?.maps ?? null;
};

test.describe('glTF texture-map capture — IR descriptor + byte-identical render', () => {
  test('captures the albedo texture into the project; the draw is textured', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestAlbedoQuad(page);

    await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');

    // side A — the captured albedo map names the project's copy of the image.
    await expect.poll(async () => (await capturedMaps(page))?.albedo?.store).toBe('project');
    const maps = await capturedMaps(page);
    expect(maps?.albedo).toMatchObject({
      colorSpace: 'srgb', // baseColor is sRGB (glTF convention)
      flipY: false, // glTF textures are flipY=false
    });
    expect(maps?.albedo?.hash).toMatch(PROJECT_IMAGE_KEY);
    // This material has only a baseColorTexture → the other slots stay null.
    expect(maps?.roughness).toBeNull();
    expect(maps?.metalness).toBeNull();

    // side B — the drawn material carries the stored image, decoded.
    await expect
      .poll(async () => (await drawnImportMeshes(page)).some((m) => m.hasMap && m.mapImageOk))
      .toBe(true);
  });
});
