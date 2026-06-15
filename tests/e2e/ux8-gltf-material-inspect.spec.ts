// UX backlog #8 — a glTF model's embedded materials are VISIBLE/INSPECTABLE.
//
// THE BUG THIS KILLS
// ==================
// A glTF's embedded materials live only on the three.js clone GltfAssetR mounts,
// never in the DAG. So selecting a GltfAsset showed an EMPTY material section,
// and a GltfChild had no material section at all — the director could not even
// SEE what materials the model carries (observed: the two-material quad renders
// red + blue but the inspector showed nothing).
//
// THE FIX (read-only): GltfAssetR publishes a read-only per-slot material
// summary (gltfMaterialStore); the inspector's MATERIAL section renders it for a
// GltfAsset (all slots) or GltfChild (its slots). Editing stays with the
// MaterialOverride wrapper.
//
// Falsification: stop publishing (or revert the NPanel readout) → the asserts
// below find no `gltf-material-readout` / no per-slot color.
//
// REF: src/app/asset/readGltfMaterials.ts, gltfMaterialStore.ts;
//      src/viewport/SceneFromDAG.tsx (publish); src/app/NPanel.tsx (readout).

import { test, expect } from './_fixtures';

const ASSET_REF = 'assets/two-material-textured-quad.gltf';
const FIXTURE_URL = '/assets/two-material-textured-quad.gltf';

interface W {
  __basher_dag: {
    getState: () => { state: { nodes: Record<string, { id: string; type: string }> } };
  };
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<{ gltfAssetId: string }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_meshes?: () => unknown[];
  __basher_selection?: { getState: () => { select: (id: string) => void } };
}

async function stageQuad(page: import('@playwright/test').Page) {
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as W;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : []).length === 2;
    },
    { timeout: 15_000 },
  );
}

function selectType(page: import('@playwright/test').Page, type: string) {
  return page.evaluate((t) => {
    const w = window as unknown as W;
    const node = Object.values(w.__basher_dag.getState().state.nodes).find((n) => n.type === t);
    if (node) w.__basher_selection!.getState().select(node.id);
    return node?.id ?? null;
  }, type);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menubar')).toBeVisible();
  await stageQuad(page);
});

test('a GltfAsset inspector shows every embedded material slot with its base color + maps', async ({
  page,
}) => {
  await selectType(page, 'GltfAsset');
  // MATERIAL is not the primary section for an asset → default-collapsed; expand.
  await page.getByTestId('inspector-section-toggle-material').click();
  await expect(page.getByTestId('gltf-material-readout')).toBeVisible();

  // Two slots: slot 0 = RedMat (no maps), slot 1 = BlueMat (roughness+metalness maps).
  await expect(page.getByTestId('gltf-material-slot-0')).toContainText('RedMat');
  await expect(page.getByTestId('gltf-material-slot-1')).toContainText('BlueMat');
  await expect(page.getByTestId('gltf-material-slot-1')).toContainText('roughness');

  // The base-color swatch reflects the real material colour (not a placeholder).
  const swatch = page.getByTestId('gltf-material-swatch-0');
  const bg = await swatch.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(255, 0, 0)'); // RedMat #ff0000
});

test('a GltfChild inspector shows the EDITABLE material editor (S4 superseded the read-only readout)', async ({
  page,
}) => {
  // UX #8 originally showed a read-only readout here; #178 S4 makes a GltfChild
  // that captured OpenPBR materials (S2) EDITABLE — it now renders the lobe
  // editor, not the readout (the editable case is gated by ux-gltf-material-edit;
  // the readout is still exercised by the whole-asset GltfAsset test above).
  const childId = await selectType(page, 'GltfChild');
  expect(childId).not.toBeNull();
  await page.getByTestId('inspector-section-toggle-material').click();
  await expect(page.getByTestId(`inspector-gltf-material-editor-${childId}`)).toBeVisible();
  await expect(page.getByTestId('gltf-material-readout')).toHaveCount(0);
});
