// #178 (S5) — the renderer applies a GltfChild material's EDIT-LAYER texture maps
// onto the imported clone. The edit-layer model: maps[slot] null = inherit the
// imported texture, CLEARED_MAP sentinel (empty hash) = remove it, a real ref =
// replace it.
//
// THE PROOF (falsifiable, no baking needed): import a base-color-textured quad →
// its rendered material has a map (hasMap true). Set materials[0].maps.albedo to
// the cleared sentinel → the rendered clone DROPS its base map (hasMap false).
// Set it back to null → the overlay re-clones from the pristine import, so the
// imported texture is RESTORED (hasMap true). If the overlay ignored edit-layer
// maps (the pre-S5 behaviour), hasMap would never change.

import { test, expect } from './_fixtures';
import { firstMaterialChild } from './_importedChild';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<{ gltfAssetId: string }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_meshes?: () => { name: string; color: string | null; hasMap: boolean }[];
}

const CLEARED_MAP = {
  hash: '',
  colorSpace: 'no-colorspace',
  flipY: false,
  wrapS: 1001,
  wrapT: 1001,
};

const REF = 'assets/albedo-textured-quad.gltf';

async function stageQuad(page: import('@playwright/test').Page) {
  await page.evaluate(
    async ({ ref }) => {
      const w = window as unknown as W;
      const buf = await fetch(`/${ref}`).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    { ref: REF },
  );
}

// #389 — the DATA half's id: that is the node a material write is addressed to now.
async function child(page: import('@playwright/test').Page) {
  return (await firstMaterialChild(page))?.dataId ?? null;
}

const firstHasMap = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as W;
    const meshes = w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
    return meshes[0]?.hasMap ?? null;
  });

function setAlbedo(page: import('@playwright/test').Page, id: string, albedo: unknown) {
  return page.evaluate(
    ({ id, albedo }) => {
      const w = window as unknown as W;
      const node = w.__basher_dag.getState().state.nodes[id];
      // #389 — slot 0 IS `material`; the multi-slot table lives in `materialSlots` and
      // this fixture has one primitive, so the old map-over-the-array is now a direct
      // whole-`material` replace on the DATA half.
      const mat = node.params.material as { maps: Record<string, unknown> };
      w.__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId: id,
            paramPath: 'material',
            value: { ...mat, maps: { ...mat.maps, albedo } },
          },
        ],
        'user',
        'edit gltf map',
      );
    },
    { id, albedo },
  );
}

test.describe('#178 S5 — renderer applies edit-layer glTF maps', () => {
  test('clearing maps.albedo removes the imported base map; null restores it', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as W).__basher_importGltf === 'function',
    );
    await stageQuad(page);
    await expect.poll(() => child(page)).not.toBeNull();
    const id = (await child(page))!;

    // Imported base-color texture renders.
    await expect.poll(() => firstHasMap(page)).toBe(true);

    // Clear → the rendered clone drops its base map.
    await setAlbedo(page, id, CLEARED_MAP);
    await expect.poll(() => firstHasMap(page)).toBe(false);

    // Back to null (inherit) → the overlay re-clones the pristine import → restored.
    await setAlbedo(page, id, null);
    await expect.poll(() => firstHasMap(page)).toBe(true);
  });
});
